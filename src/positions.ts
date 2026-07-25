/** Open-position store, persisted as JSON so restarts keep positions.
 *
 * A position is opened when a buy succeeds (or, in dry run, when a buy
 * would have happened — those are marked `paper` and never touch chain,
 * which turns dry run into a full paper-trading record).
 */
import fs from "node:fs";

import { config } from "./config.js";

export interface Position {
  address: string;
  chain: string;
  symbol: string;
  entryPriceUsd: number;
  spentNative: number; // amount of native coin paid (origin coin for Relay buys)
  openedAt: string;
  soldFraction: number; // 0-1 of the original position sold so far
  hitTiers: number[]; // take-profit multiples already executed
  paper: boolean; // opened in dry run — simulated only
  closed: boolean;
  closedReason?: string;
  failures?: number; // consecutive sell failures (honeypot detection)
}

export function positionKey(chain: string, address: string): string {
  return `${chain}:${address.toLowerCase()}`;
}

export function loadPositions(): Position[] {
  if (!fs.existsSync(config.POSITIONS_FILE)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(config.POSITIONS_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function savePositions(positions: Position[]): void {
  fs.writeFileSync(config.POSITIONS_FILE, JSON.stringify(positions, null, 2));
}

/** Add a position (or refresh an existing open one for the same token). */
export function openPosition(p: {
  address: string;
  chain: string;
  symbol: string;
  entryPriceUsd: number;
  spentNative: number;
  paper: boolean;
  now: string;
}): Position {
  const positions = loadPositions();
  const existing = positions.find(
    (q) => !q.closed && positionKey(q.chain, q.address) === positionKey(p.chain, p.address)
  );
  if (existing) return existing;

  const position: Position = {
    address: p.address,
    chain: p.chain,
    symbol: p.symbol,
    entryPriceUsd: p.entryPriceUsd,
    spentNative: p.spentNative,
    openedAt: p.now,
    soldFraction: 0,
    hitTiers: [],
    paper: p.paper,
    closed: false,
  };
  positions.push(position);
  savePositions(positions);
  return position;
}

/** Apply a mutation to one stored position and persist. */
export function updatePosition(
  chain: string,
  address: string,
  mutate: (p: Position) => void
): void {
  const positions = loadPositions();
  const target = positions.find(
    (q) => positionKey(q.chain, q.address) === positionKey(chain, address) && !q.closed
  );
  if (!target) return;
  mutate(target);
  savePositions(positions);
}
