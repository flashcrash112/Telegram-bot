/** Buy and sell tokens on an EVM chain via a UniswapV2-compatible router.
 *
 * Both directions use the SupportingFeeOnTransferTokens variants so
 * trades still succeed on tokens that take a transfer tax.
 */
import {
  Contract, JsonRpcProvider, MaxUint256, Wallet,
  getAddress, parseEther, parseUnits, formatEther,
} from "ethers";

import { config } from "./config.js";
import { EvmChain, routerFor, rpcFor, wrappedNativeFor } from "./chains.js";
import { makeLog } from "./log.js";

const log = makeLog("evm_swap");

const ROUTER_ABI = [
  "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable",
  "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)",
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
];

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
];

/** Swap `amountNative` of the chain's native coin for `tokenAddress`.
 *
 * Returns the transaction hash. Throws on failure.
 */
export async function buy(
  chain: EvmChain,
  tokenAddress: string,
  amountNative: number
): Promise<string> {
  if (!config.EVM_PRIVATE_KEY) throw new Error("EVM_PRIVATE_KEY is not set");

  const provider = new JsonRpcProvider(rpcFor(chain), chain.chainId, {
    staticNetwork: true,
  });
  const wallet = new Wallet(config.EVM_PRIVATE_KEY, provider);
  const router = new Contract(getAddress(routerFor(chain)), ROUTER_ABI, wallet);
  const path = [getAddress(wrappedNativeFor(chain)), getAddress(tokenAddress)];
  const amountIn = parseEther(String(amountNative));

  const balance = await provider.getBalance(wallet.address);
  if (balance < amountIn) {
    throw new Error(
      `insufficient ${chain.nativeSymbol}: have ${formatEther(balance)}, ` +
        `need ${amountNative} plus gas`
    );
  }

  const amountsOut: bigint[] = await router.getAmountsOut(amountIn, path);
  const amountOutMin =
    (amountsOut[amountsOut.length - 1] * BigInt(10_000 - config.SLIPPAGE_BPS)) / 10_000n;

  const block = await provider.getBlock("latest");
  if (!block) throw new Error(`cannot reach RPC for ${chain.name}: ${rpcFor(chain)}`);
  const deadline = block.timestamp + 120;

  const overrides: Record<string, unknown> = { value: amountIn };
  if (chain.eip1559) {
    const priority = parseUnits("2", "gwei");
    const baseFee = block.baseFeePerGas ?? (await provider.getFeeData()).gasPrice ?? 0n;
    overrides.maxPriorityFeePerGas = priority;
    overrides.maxFeePerGas = baseFee * 2n + priority;
  } else {
    overrides.gasPrice = (await provider.getFeeData()).gasPrice;
  }

  const args = [amountOutMin, path, wallet.address, deadline];
  const estimated: bigint = await router
    .getFunction("swapExactETHForTokensSupportingFeeOnTransferTokens")
    .estimateGas(...args, overrides);
  overrides.gasLimit = (estimated * 13n) / 10n;

  const tx = await router.swapExactETHForTokensSupportingFeeOnTransferTokens(...args, overrides);
  log.info(`[${chain.name}] buy sent: ${tx.hash}`);

  const receipt = await tx.wait(1, 180_000);
  if (!receipt || receipt.status !== 1) {
    throw new Error(`swap transaction reverted: ${tx.hash}`);
  }
  return tx.hash;
}

/** Raw token balance and decimals held by the bot's wallet. */
export async function tokenBalance(
  chain: EvmChain,
  tokenAddress: string
): Promise<{ raw: bigint; decimals: number }> {
  if (!config.EVM_PRIVATE_KEY) throw new Error("EVM_PRIVATE_KEY is not set");
  const provider = new JsonRpcProvider(rpcFor(chain), chain.chainId, { staticNetwork: true });
  const wallet = new Wallet(config.EVM_PRIVATE_KEY, provider);
  const token = new Contract(getAddress(tokenAddress), ERC20_ABI, provider);
  const [raw, decimals] = await Promise.all([
    token.balanceOf(wallet.address) as Promise<bigint>,
    token.decimals().then(Number).catch(() => 18),
  ]);
  return { raw, decimals };
}

/** Sell `amountRaw` base units of `tokenAddress` back into the native coin.
 *
 * Approves the router first when the current allowance is too low.
 * Returns the swap transaction hash.
 */
export async function sell(
  chain: EvmChain,
  tokenAddress: string,
  amountRaw: bigint
): Promise<string> {
  if (!config.EVM_PRIVATE_KEY) throw new Error("EVM_PRIVATE_KEY is not set");
  if (amountRaw <= 0n) throw new Error("nothing to sell");

  const provider = new JsonRpcProvider(rpcFor(chain), chain.chainId, { staticNetwork: true });
  const wallet = new Wallet(config.EVM_PRIVATE_KEY, provider);
  const routerAddress = getAddress(routerFor(chain));
  const router = new Contract(routerAddress, ROUTER_ABI, wallet);
  const token = new Contract(getAddress(tokenAddress), ERC20_ABI, wallet);
  const path = [getAddress(tokenAddress), getAddress(wrappedNativeFor(chain))];

  const allowance: bigint = await token.allowance(wallet.address, routerAddress);
  if (allowance < amountRaw) {
    const approveTx = await token.approve(routerAddress, MaxUint256);
    log.info(`[${chain.name}] approve sent: ${approveTx.hash}`);
    const approveReceipt = await approveTx.wait(1, 180_000);
    if (!approveReceipt || approveReceipt.status !== 1) {
      throw new Error(`token approval reverted: ${approveTx.hash}`);
    }
  }

  // A taxed token returns less than the quote; the quote is only used to
  // set the slippage floor, so apply the tolerance to it directly.
  let amountOutMin = 0n;
  try {
    const amountsOut: bigint[] = await router.getAmountsOut(amountRaw, path);
    amountOutMin =
      (amountsOut[amountsOut.length - 1] * BigInt(10_000 - config.SLIPPAGE_BPS)) / 10_000n;
  } catch {
    log.warn(`[${chain.name}] getAmountsOut failed for the sell — submitting without a floor`);
  }

  const block = await provider.getBlock("latest");
  if (!block) throw new Error(`cannot reach RPC for ${chain.name}: ${rpcFor(chain)}`);
  const deadline = block.timestamp + 120;

  const overrides: Record<string, unknown> = {};
  if (chain.eip1559) {
    const priority = parseUnits("2", "gwei");
    const baseFee = block.baseFeePerGas ?? (await provider.getFeeData()).gasPrice ?? 0n;
    overrides.maxPriorityFeePerGas = priority;
    overrides.maxFeePerGas = baseFee * 2n + priority;
  } else {
    overrides.gasPrice = (await provider.getFeeData()).gasPrice;
  }

  const args = [amountRaw, amountOutMin, path, wallet.address, deadline];
  const estimated: bigint = await router
    .getFunction("swapExactTokensForETHSupportingFeeOnTransferTokens")
    .estimateGas(...args, overrides);
  overrides.gasLimit = (estimated * 13n) / 10n;

  const tx = await router.swapExactTokensForETHSupportingFeeOnTransferTokens(...args, overrides);
  log.info(`[${chain.name}] sell sent: ${tx.hash}`);

  const receipt = await tx.wait(1, 180_000);
  if (!receipt || receipt.status !== 1) {
    throw new Error(`sell transaction reverted: ${tx.hash}`);
  }
  return tx.hash;
}
