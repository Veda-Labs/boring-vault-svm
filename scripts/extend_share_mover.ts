import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, ComputeBudgetProgram, Transaction } from "@solana/web3.js";
import fs from "fs";

// -----------------------------------------------------------------------------
// Configuration – edit if needed
// -----------------------------------------------------------------------------
// ShareMover PDA that needs to be extended (old size = -32 bytes)
const SHARE_MOVER_PDA = new PublicKey(
  "6YsXQgyWC4RUW1SiGdhKvvKKEKjPjDMsDxHTBFWbx7BA"
);
// Corresponding share mint. Do not change unless the ShareMover address changes.
const SHARE_MINT = new PublicKey(
  "88ZgQ7nKQeAHV7Q4ivAT7QaeabCzSpuKa8T8PNRaAm4e"
);
// Optional: RPC URL (falls back to ANCHOR_PROVIDER_URL)
const RPC_URL = process.env.ANCHOR_PROVIDER_URL || "https://api.mainnet-beta.solana.com";

// -----------------------------------------------------------------------------
function loadKeypair(path: string) {
  const pk = JSON.parse(fs.readFileSync(path.replace("~", process.env.HOME || ""), "utf8"));
  return anchor.web3.Keypair.fromSecretKey(Uint8Array.from(pk));
}

(async () => {
  // Provider -------------------------------------------------------------
  const conn = new Connection(RPC_URL, { commitment: "confirmed" });
  const payer = loadKeypair(process.env.ANCHOR_WALLET!);
  const provider = new AnchorProvider(conn, new Wallet(payer), {
    commitment: "confirmed",
    skipPreflight: false,
  });
  anchor.setProvider(provider);

  // Obtain program reference from workspace ----------------------------------
  const smProgram = (anchor.workspace as any).LayerZeroShareMover as Program<any>;

  // Build instruction --------------------------------------------------------
  const ix = await (smProgram as any).methods
    .extendShareMover(SHARE_MINT)
    .accounts({
      signer: payer.publicKey,
      shareMover: SHARE_MOVER_PDA,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .signers([payer])
    .instruction();

  // Optional: boost compute if hitting limit (not required for realloc <1k)
  const modifyCu = ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 });

  const tx = new Transaction({ feePayer: payer.publicKey })
    .add(modifyCu)
    .add(ix);

  console.log("Sending extend_share_mover tx …");
  try {
    const sig = await provider.sendAndConfirm(tx, [payer]);
    console.log("✓ Extend success: ", sig);
  } catch (err: any) {
    if (err?.logs) {
      console.error("Transaction failed. Logs:\n", err.logs.join("\n"));
    } else if (typeof err?.getLogs === "function") {
      console.error("Transaction failed. Logs:\n", err.getLogs()?.join("\n"));
    } else {
      console.error("Transaction failed: ", err);
    }
    throw err;
  }
})();
