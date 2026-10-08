/*
 * Copyright (c) 2026 Atum Labs, Inc.
 * SPDX-License-Identifier: MIT
 */

// Terminal chrome shared across the Atum examples. Copied into each app (they are
// standalone packages) so a recording of any of them reads the same way.

const tty = Boolean(process.stdout.isTTY);

function paint(code: string, text: string): string {
  return tty ? `\x1b[${code}m${text}\x1b[0m` : text;
}

export const style = {
  dim: (s: string) => paint("2", s),
  bold: (s: string) => paint("1", s),
  cyan: (s: string) => paint("36", s),
  green: (s: string) => paint("32", s),
  yellow: (s: string) => paint("33", s),
};

export const BAR = "─".repeat(58);

const CHAIN_NAMES: Record<string, string> = {
  "eip155:84532": "Base Sepolia",
  "eip155:42431": "Tempo (Moderato)",
};

const ASSET_NAMES: Record<string, string> = {
  "0x036cbd53842c5426634e7929541ec2318f3dcf7e": "USDC",
  "0x20c0000000000000000000000000000000000000": "pathUSD",
};

export function assetName(asset: string): string {
  return ASSET_NAMES[asset.toLowerCase()] ?? asset;
}

export function endpointLabel(network: string, asset: string): string {
  return `${CHAIN_NAMES[network] ?? network} ${assetName(asset)}`;
}

export function corridorLabel(
  sourceNetwork: string,
  sourceAsset: string,
  destNetwork: string,
  destAsset: string,
): string {
  return `${endpointLabel(sourceNetwork, sourceAsset)} → ${endpointLabel(destNetwork, destAsset)}`;
}

/** 50000 atomic of a 6-decimal token → "0.05". */
export function formatAmount(atomic: string, decimals = 6): string {
  const n = BigInt(atomic);
  const base = 10n ** BigInt(decimals);
  const whole = n / base;
  const frac = (n % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export function banner(product: string, mode: string): void {
  console.log("");
  console.log(`⚡  ${style.bold("ATUM")} · ${product} · ${style.dim(mode)}`);
}

export function successBanner(message: string): void {
  console.log("");
  console.log(style.green(BAR));
  console.log(`  🎉  ${style.bold(message)}`);
  console.log(style.green(BAR));
}

export function line(emoji: string, message: string): void {
  console.log(`${emoji}  ${message}`);
}

export function detail(message: string): void {
  console.log(`    ${message}`);
}

const TX_EXPLORERS: Record<string, string> = {
  "eip155:84532": "https://sepolia.basescan.org/tx/",
  "eip155:42431": "https://explore.testnet.tempo.xyz/tx/",
};

export function txLink(chainId: string | undefined, hash: string | undefined): string {
  if (!hash) return "(none)";
  const base = chainId ? TX_EXPLORERS[chainId] : undefined;
  return base ? `${base}${hash}` : `${hash}${chainId ? ` (${chainId})` : ""}`;
}

export function chainName(network: string): string {
  return CHAIN_NAMES[network] ?? network;
}

/** Same destination-arrival line in every app, stub or real. */
export function logArrival(args: {
  destNetwork?: string;
  destAsset?: string;
  destHash?: string;
  sourceNetwork?: string;
  sourceHash?: string;
  stub?: boolean;
}): void {
  const impliedAsset: Record<string, string> = {
    "eip155:42431": "0x20c0000000000000000000000000000000000000",
    "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  };
  const destAsset = args.destAsset ?? (args.destNetwork ? impliedAsset[args.destNetwork] : undefined);
  const dest =
    args.destNetwork && destAsset
      ? endpointLabel(args.destNetwork, destAsset)
      : args.destNetwork
        ? chainName(args.destNetwork)
        : "destination";
  const tag = args.stub ? " (stub)" : "";
  console.log(`   Destination  ${dest} — arrived${tag}`);
  if (args.stub) return;
  if (args.destHash) console.log(`   destination payout: ${txLink(args.destNetwork, args.destHash)}`);
  if (args.sourceHash) console.log(`   source deposit:     ${txLink(args.sourceNetwork, args.sourceHash)}`);
}

export function settledAfter(attempts: number, extra?: string): string {
  const head = attempts <= 1 ? "  ✅  Payment settled." : `  ✅  Payment settled after ${attempts} attempts.`;
  return extra ? `${head} ${extra}` : head;
}
