/** Buy tokens on any supported chain from a single funding wallet, via
 * Relay (https://relay.link).
 *
 * Instead of holding native gas coins on every chain, you fund ONE wallet
 * on ONE origin chain (e.g. ETH on Base). For each detected token, Relay
 * quotes a cross-chain swap: we sign and send the origin-chain
 * transaction(s) it returns, and Relay's solvers deliver the destination
 * token to the recipient — including SPL tokens on Solana.
 *
 * Flow: POST /quote -> execute returned origin-chain tx steps -> poll the
 * status endpoint until the fill succeeds.
 */
import { JsonRpcProvider, Wallet, getAddress, parseEther, parseUnits, formatEther } from "ethers";

import { config } from "./config.js";
import { EVM_CHAINS, EvmChain, SOLANA_KEY, rpcFor } from "./chains.js";
import { makeLog } from "./log.js";

const log = makeLog("relay_buyer");

export const RELAY_API = "https://api.relay.link";
export const NATIVE_EVM = "0x0000000000000000000000000000000000000000";
// Relay's chain id for Solana mainnet.
export const RELAY_SOLANA_CHAIN_ID = 792703809;

const STATUS_POLL_SECONDS = 3;
const STATUS_POLL_TRIES = 60;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function destinationChainId(chainKey: string): number | null {
  if (chainKey === SOLANA_KEY) return RELAY_SOLANA_CHAIN_ID;
  return EVM_CHAINS[chainKey]?.chainId ?? null;
}

/** Where SPL tokens should land when buying a Solana token cross-chain. */
export async function solanaRecipient(): Promise<string> {
  if (config.SOLANA_RECIPIENT) return config.SOLANA_RECIPIENT;
  if (config.SOLANA_PRIVATE_KEY) {
    const [{ Keypair }, bs58] = await Promise.all([
      import("@solana/web3.js"),
      import("bs58").then((m) => m.default),
    ]);
    return Keypair.fromSecretKey(bs58.decode(config.SOLANA_PRIVATE_KEY)).publicKey.toBase58();
  }
  return "";
}

export async function buildQuoteBody(
  user: string,
  destChainKey: string,
  tokenAddress: string,
  amountWei: bigint
): Promise<Record<string, unknown>> {
  const origin = EVM_CHAINS[config.RELAY_ORIGIN_CHAIN];
  const destId = destinationChainId(destChainKey);
  if (destId === null) {
    throw new Error(`chain '${destChainKey}' is not supported via Relay`);
  }

  let recipient = user;
  if (destChainKey === SOLANA_KEY) {
    recipient = await solanaRecipient();
    if (!recipient) {
      throw new Error("Solana destination needs SOLANA_RECIPIENT or SOLANA_PRIVATE_KEY set");
    }
  }

  return {
    user,
    recipient,
    originChainId: origin.chainId,
    destinationChainId: destId,
    originCurrency: NATIVE_EVM,
    destinationCurrency: tokenAddress,
    amount: amountWei.toString(),
    tradeType: "EXACT_INPUT",
    slippageTolerance: String(config.SLIPPAGE_BPS),
  };
}

/** Swap `amountOriginNative` of the origin chain's native coin into
 * `tokenAddress` on `destChainKey`. Returns the last origin tx hash.
 */
export async function buy(
  destChainKey: string,
  tokenAddress: string,
  amountOriginNative: number
): Promise<string> {
  if (!config.EVM_PRIVATE_KEY) {
    throw new Error("EVM_PRIVATE_KEY is not set (Relay origin wallet)");
  }

  const origin = EVM_CHAINS[config.RELAY_ORIGIN_CHAIN];
  const provider = new JsonRpcProvider(rpcFor(origin), origin.chainId, { staticNetwork: true });
  const wallet = new Wallet(config.EVM_PRIVATE_KEY, provider);
  const amountWei = parseEther(String(amountOriginNative));

  const balance = await provider.getBalance(wallet.address);
  if (balance < amountWei) {
    throw new Error(
      `insufficient ${origin.nativeSymbol} on ${origin.name}: ` +
        `have ${formatEther(balance)}, need ${amountOriginNative} plus gas`
    );
  }

  const body = await buildQuoteBody(wallet.address, destChainKey, tokenAddress, amountWei);

  const quoteResp = await fetch(`${RELAY_API}/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const quote = await quoteResp.json();
  if (quoteResp.status !== 200) {
    throw new Error(`Relay quote failed (${quoteResp.status}): ${JSON.stringify(quote)}`);
  }

  let txHash = "";
  const checkEndpoints: string[] = [];
  for (const step of quote.steps ?? []) {
    if (step.kind !== "transaction") continue;
    for (const item of step.items ?? []) {
      const data = item.data ?? {};
      txHash = await sendOriginTx(provider, wallet, origin, data);
      log.info(`[Relay] step '${step.id}' sent on ${origin.name}: ${txHash}`);
      if (item.check?.endpoint) checkEndpoints.push(item.check.endpoint);
    }
  }

  if (!txHash) {
    throw new Error(`Relay quote returned no executable transaction steps: ${JSON.stringify(quote)}`);
  }

  for (const endpoint of checkEndpoints) {
    await waitForFill(endpoint);
  }
  return txHash;
}

/** Relay may return numeric fields as int, decimal string, or hex string. */
export function toInt(value: unknown): bigint {
  if (value === null || value === undefined) return 0n;
  if (typeof value === "string") {
    return value.startsWith("0x") ? BigInt(value) : BigInt(parseInt(value, 10));
  }
  return BigInt(value as number);
}

async function sendOriginTx(
  provider: JsonRpcProvider,
  wallet: Wallet,
  origin: EvmChain,
  data: Record<string, any>
): Promise<string> {
  const tx: Record<string, unknown> = {
    to: getAddress(data.to),
    data: data.data ?? "0x",
    value: toInt(data.value),
    chainId: origin.chainId,
  };
  if (origin.eip1559) {
    const block = await provider.getBlock("latest");
    const priority = parseUnits("2", "gwei");
    const baseFee = block?.baseFeePerGas ?? (await provider.getFeeData()).gasPrice ?? 0n;
    tx.maxPriorityFeePerGas = priority;
    tx.maxFeePerGas = baseFee * 2n + priority;
  } else {
    tx.gasPrice = (await provider.getFeeData()).gasPrice;
  }
  const estimated = await provider.estimateGas({ ...tx, from: wallet.address } as any);
  tx.gasLimit = (estimated * 13n) / 10n;

  const sent = await wallet.sendTransaction(tx as any);
  const receipt = await sent.wait(1, 180_000);
  if (!receipt || receipt.status !== 1) {
    throw new Error(`Relay origin transaction reverted: ${sent.hash}`);
  }
  return sent.hash;
}

/** Poll Relay's status endpoint until the cross-chain fill completes. */
async function waitForFill(endpoint: string): Promise<void> {
  const url = endpoint.startsWith("http") ? endpoint : `${RELAY_API}${endpoint}`;
  for (let i = 0; i < STATUS_POLL_TRIES; i++) {
    await sleep(STATUS_POLL_SECONDS * 1000);
    let status = "";
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      status = (await resp.json())?.status ?? "";
    } catch {
      continue;
    }
    if (status === "success") {
      log.info("[Relay] fill confirmed");
      return;
    }
    if (["failure", "refund"].includes(status)) {
      throw new Error(`Relay fill ended with status '${status}'`);
    }
  }
  throw new Error("Relay fill not confirmed in time (check relay.link/transactions)");
}
