/** Buy a token on an EVM chain via a UniswapV2-compatible router.
 *
 * Uses swapExactETHForTokensSupportingFeeOnTransferTokens so buys still
 * succeed on tokens that take a transfer tax.
 */
import { Contract, JsonRpcProvider, Wallet, getAddress, parseEther, parseUnits, formatEther } from "ethers";

import { config } from "./config.js";
import { EvmChain, routerFor, rpcFor } from "./chains.js";
import { makeLog } from "./log.js";

const log = makeLog("evm_buyer");

const ROUTER_ABI = [
  "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable",
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
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
  const path = [getAddress(chain.wrappedNative), getAddress(tokenAddress)];
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
