import { Connection, Keypair } from "@solana/web3.js";
import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
import * as anchor from "@coral-xyz/anchor";
import fs from "fs";

// -----------------------------------------------------------------------------
// Keypair helpers
// -----------------------------------------------------------------------------

/**
 * Reads a Keypair from the filesystem.
 *
 * The file is expected to contain a JSON array of numbers identical to the
 * format produced by `solana-keygen`.
 */
export function loadKeypair(path: string): Keypair {
  const pk = JSON.parse(fs.readFileSync(path.replace("~", process.env.HOME || ""), "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(pk));
}

// -----------------------------------------------------------------------------
// Anchor helpers
// -----------------------------------------------------------------------------

export interface AnchorContext {
  connection: Connection;
  payer: Keypair;
  provider: AnchorProvider;
}

/**
 * Creates a Connection + Provider and assigns it as the global Anchor provider.
 *
 * If `rpcUrl` is omitted it falls back to `ANCHOR_PROVIDER_URL` or mainnet-beta.
 */
export function initAnchor(rpcUrl?: string): AnchorContext {
  const url =
    rpcUrl || process.env.ANCHOR_PROVIDER_URL || process.env.ALCHEMY_API_KEY || "https://api.mainnet-beta.solana.com";

  const connection = new Connection(url, { commitment: "confirmed" });
  const payer = loadKeypair(process.env.ANCHOR_WALLET!);
  const provider = new AnchorProvider(connection, new Wallet(payer), {
    commitment: "confirmed",
    skipPreflight: false,
  });

  anchor.setProvider(provider);
  return { connection, payer, provider };
}

// -----------------------------------------------------------------------------
// Misc helpers
// -----------------------------------------------------------------------------

/** Converts a hex string (with or without 0x prefix) to a Buffer. */
export function hexBuf(hex: string): Buffer {
  return Buffer.from(hex.replace(/^0x/, ""), "hex");
}

/**
 * Pads an EVM address (or arbitrary byte string) to 32 bytes as expected by
 * LayerZero. The address is right-aligned (big-endian). Throws if the input
 * exceeds 32 bytes.
 */
export function padRecipient(addr: string): Buffer {
  let cleaned = addr.toLowerCase().replace(/^0x/, "");
  if (cleaned.length % 2 !== 0) cleaned = "0" + cleaned;
  const buf = Buffer.from(cleaned, "hex");
  if (buf.length > 32) throw new Error("EVM address >32 bytes");
  const out = Buffer.alloc(32);
  buf.copy(out, 32 - buf.length);
  return out;
}
