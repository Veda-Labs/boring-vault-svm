import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import fs from "fs";
import BN from "bn.js";
import { EndpointProgram, SimpleMessageLibProgram, UlnProgram } from "@layerzerolabs/lz-solana-sdk-v2";
import { initAnchor, padRecipient, hexBuf } from "./utils";
import { derivePdas } from "./pda";
import { LayerZeroShareMover } from "../target/types/layer_zero_share_mover";

/*
 * Script: send_message.ts
 * ----------------------
 * Bridges shares from Solana → Scroll by calling the LayerZeroShareMover `send`
 * instruction.  The script mirrors the structure of the existing helper scripts
 * in `scripts/` and computes all PDAs & remaining accounts required by the
 * on-chain instruction.
 *
 * Before running, update the CONSTANTS section as needed (amount, receiver,
 * fee, etc.).
 *
 *    ANCHOR_PROVIDER_URL=https://api.mainnet-beta.solana.com \
 *    ANCHOR_WALLET=~/.config/solana/id.json                 \
 *    ts-node scripts/send_message.ts
 */

// ─── CONSTANTS – UPDATE AS NEEDED ───────────────────────────────────────────
/**
 * LayerZero destination endpoint identifier for the Scroll network.
 */
const DST_EID = 30214; // LayerZero endpoint ID for the Scroll network
const RECEIVER_EVM_ADDRESS =
  "0x000000000000000000000000c1caf4915849cd5fe21efaa4ae14e4eafa7a3431"; // 20-byte EVM, padded to 32 big endian
const AMOUNT_SHARES = 100_000n; // Amount of Boring-Vault shares (u64) to bridge
// legacy type1 options: format_type=1 + 16 bytes zero + 16-byte gas (500_000)
const OPTIONS_HEX = "0001000000000000000000000000000000000000000000000000000000000007a120";
const NATIVE_FEE_LAMPORTS = 100_000_000n; // Native fee to pay in SOL (lamports)
const LZ_TOKEN_FEE = 0n; // Fee to pay in ZRO (typically 0 when paying native)

// Toggle between a dry-run (simulate) and an on-chain send. Set to `false` to
// actually submit the transaction.
const SIMULATION = true;

// Programs / PDAs -----------------------------------------------------------
const SHARE_MINT = new PublicKey(
  "88ZgQ7nKQeAHV7Q4ivAT7QaeabCzSpuKa8T8PNRaAm4e"
);
const SHARE_MOVER_PROGRAM_ID = new PublicKey(
  "CU9XermEoiawu8eYwSyXBHgMESRwWEycDU9jjk9MHSgN"
);
const ENDPOINT_PROGRAM_ID = new PublicKey(
  "76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6"
);
const BORING_VAULT_PROGRAM_ID = new PublicKey(
  "5ZRnXG4GsUMLaN7w2DtJV1cgLgcXHmuHCmJ2MxoorWCE"
);
const VAULT_ID = 14n; // vault backing this share mint
const SEND_LIBRARY_PROGRAM_ID = new PublicKey("7a4WjyR8VZ7yZz5XJAKm39BUGn5iT9CKcv2pmG9tdXVH");

const DVN_PROGRAM_ID      = new PublicKey("4VDjp6XQaxoZf5RGwiPU9NR1EXSZn2TP4ATMmiSzLfhb");

// Derive PDAs inside `main()` where we have the Anchor provider context.

/**
 * Resolves the concrete Message-Library program (SimpleMessageLib vs ULN) for
 * the given OApp + destination chain.
 *
 * The Endpoint SDK returns both the library programId and its semantic version.
 * We convert that into the strongly-typed client from the SDK so that the rest
 * of the script can remain agnostic of which library is being used.
 */
async function getSendLibraryProgram(
  endpointSDK: any,
  connection: Connection,
  payer: PublicKey,
  dstEid: number,
  oapp: PublicKey
): Promise<SimpleMessageLibProgram.SimpleMessageLib | UlnProgram.Uln> {
  const sendLibInfo = await endpointSDK.getSendLibrary(connection, oapp, dstEid)
  if (!sendLibInfo.programId) {
      throw new Error('Send library not initialized or blocked message library')
  }
  const { programId: msgLibProgram } = sendLibInfo

  const msgLibVersion = await endpointSDK.getMessageLibVersion(connection, payer, msgLibProgram)
  const majorStr = msgLibVersion.major.toString();
  if (majorStr === "0" && msgLibVersion.minor == 0 && msgLibVersion.endpointVersion == 2) {
      return new SimpleMessageLibProgram.SimpleMessageLib(msgLibProgram)
  } else if (majorStr === "3" && msgLibVersion.minor == 0 && msgLibVersion.endpointVersion == 2) {
      return new UlnProgram.Uln(msgLibProgram)
  }
  throw new Error(`Unsupported message library version: ${JSON.stringify(msgLibVersion, null, 2)}`)
}

async function main() {
  const { connection: conn, payer, provider } = initAnchor();

  const smProgram = anchor.workspace.LayerZeroShareMover as Program<LayerZeroShareMover>;

  const receiverBuf = padRecipient(RECEIVER_EVM_ADDRESS);

  // Message library program (manually chosen / inspected via SDK)
  const chosenLib = new PublicKey("2XgGZG4oP29U3w5h4nTk1V2LFHL23zKDPJjs3psGzLKQ");

  const pdas = derivePdas({
    dstEid: DST_EID,
    shareMint: SHARE_MINT,
    vaultId: VAULT_ID,
    receiverBuf,
    shareMoverProgramId: SHARE_MOVER_PROGRAM_ID,
    endpointProgramId: ENDPOINT_PROGRAM_ID,
    boringVaultProgramId: BORING_VAULT_PROGRAM_ID,
    sendLibraryProgramId: SEND_LIBRARY_PROGRAM_ID,
    dvnProgramId: DVN_PROGRAM_ID,
    chosenLib,
  });

  const {
    shareMover: shareMoverPda,
    peer: peerPda,
    vault: vaultPda,
    shareMintPda,
    executorConfig: executorConfigPda,
    dvnConfig: dvnConfigPda,
    uln: ulnPda,
    sendLibraryConfig: sendLibraryConfigPda,
    defaultSendLibraryConfig: defaultSendLibraryConfigPda,
    sendLibraryInfo: sendLibraryInfoPda,
  } = pdas;

  console.log("shareMoverPda", shareMoverPda.toBase58());
  console.log("sendLibraryConfigPda", sendLibraryConfigPda.toBase58());
  console.log("defaultSendLibraryConfigPda", defaultSendLibraryConfigPda.toBase58());
  console.log("sendLibraryInfoPda", sendLibraryInfoPda.toBase58());

  const ata = getAssociatedTokenAddressSync(
    SHARE_MINT,
    payer.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const sendParams = {
    dstEid: DST_EID,
    recipient: Array.from(receiverBuf),
    amount: new BN(AMOUNT_SHARES.toString()),
    options: hexBuf(OPTIONS_HEX),
    nativeFee: new BN(NATIVE_FEE_LAMPORTS.toString()),
    lzTokenFee: new BN(LZ_TOKEN_FEE.toString()),
  } as any;

  const baseAccounts = {
    user: payer.publicKey,
    shareMover: shareMoverPda,
    peer: peerPda,
    vault: vaultPda,
    shareMint: shareMintPda,
    sourceTokenAccount: ata,
    tokenProgram: TOKEN_2022_PROGRAM_ID,
    systemProgram: anchor.web3.SystemProgram.programId,
    boringVaultProgram: BORING_VAULT_PROGRAM_ID,
  } as any;

  console.log("executorConfigPda", executorConfigPda.toBase58());
  console.log("dvnConfigPda", dvnConfigPda.toBase58());
  console.log("unlConfigPda", ulnPda.toBase58());

  // -------------------------------------------------------------------------
  // Use LayerZero SDK to auto-compute the full remaining-accounts list
  // -------------------------------------------------------------------------
  const endpointSdk = new EndpointProgram.Endpoint(ENDPOINT_PROGRAM_ID);

  const packetPath: any = {
    dstEid: DST_EID,
    // @ts-ignore
    sender: shareMoverPda.toBytes(),
    receiver: RECEIVER_EVM_ADDRESS,
  };

  const msgLibProgram = await getSendLibraryProgram(endpointSdk, conn, payer.publicKey, DST_EID, shareMoverPda)


  const remainSdk = await endpointSdk.getSendIXAccountMetaForCPI(
    conn,
    payer.publicKey,
    packetPath,
    msgLibProgram,
    "confirmed"
  )
  if (!remainSdk) throw new Error("Failed to fetch remaining accounts from SDK");

  // NOTE: we remove 2 accounts from the remaining accounts list:
  // [0] oapp (signer)
  // [1] endpoint program
  // otherwise, we are over the 1232kb limit.
  const remain: anchor.web3.AccountMeta[] = remainSdk.slice(2);

  // ---- Debug: print remaining accounts with owners -------------------
  console.log("\nRemaining accounts (idx, w, s, owner):");
  for (let i = 0; i < remain.length; i++) {
    const m = remain[i];
    const info = await conn.getAccountInfo(m.pubkey);
    const ownerStr = info ? info.owner.toBase58() : "N/A";
    console.log(
      `${i.toString().padStart(2, "0")}: ${m.pubkey.toBase58()}  w=${m.isWritable ? 1 : 0}  s=${m.isSigner ? 1 : 0}  owner=${ownerStr}`
    );
  }

  const ix = await smProgram.methods
    .send(sendParams)
    .accounts(baseAccounts)
    .remainingAccounts(remain)
    .signers([payer])
    .instruction();

  const modifyCU = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
  const tx = new Transaction({ feePayer: payer.publicKey })
    .add(modifyCU)
    .add(ix);

  if (SIMULATION) {
    try {
      const sim = await provider.simulate(tx, [payer]);
      console.log("✓ simulation logs:", sim.logs);
    } catch (err: any) {
      console.error("Simulation failed:", err);
      throw err;
    }
  } else {
    try {
      const sig = await provider.sendAndConfirm(tx, [payer]);
      console.log("✓ transaction confirmed. Signature:", sig);
    } catch (err: any) {
      console.error("Transaction failed:", err);
      throw err;
    }
  }
}

// Execute the script
main().catch((e) => {
  console.error(e);
  process.exit(1);
}); 