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
const DST_EID = 30214; // Scroll endpoint id
const RECEIVER_EVM_ADDRESS =
  "0x000000000000000000000000c1caf4915849cd5fe21efaa4ae14e4eafa7a3431"; // 20-byte EVM, padded to 32 big endian
const AMOUNT_SHARES = 100_000n; // u64 amount to bridge
// legacy type1 options: format_type=1 + 16 bytes zero + 16-byte gas (500_000)
const OPTIONS_HEX = "0001000000000000000000000000000000000000000000000000000000000007a120";
const NATIVE_FEE_LAMPORTS = 100_000_000n; // native fee returned by quote (set >0 when live)
const LZ_TOKEN_FEE = 0n; // fee in ZRO (usually 0 when paying native)

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

// PDA seeds (confirmed from LayerZero source)
const EXECUTOR_CFG_SEED = Buffer.from("ExecutorConfig");      // no extra bytes
const DVN_CFG_SEED      = Buffer.from("DvnConfig");           // + dst_eid.to_be_bytes()
const ULN_SEED          = Buffer.from("MessageLib");
const SEND_CFG_SEED     = Buffer.from("SendConfig");
// ────────────────────────────────────────────────────────────────────────────

function loadKeypair(path: string): Keypair {
  const pk = JSON.parse(
    fs.readFileSync(path.replace("~", process.env.HOME || ""), "utf8")
  );
  return Keypair.fromSecretKey(Uint8Array.from(pk));
}

function hexBuf(hex: string) {
  return Buffer.from(hex.replace(/^0x/, ""), "hex");
}

function padRecipient(addr: string): Buffer {
  let cleaned = addr.toLowerCase().replace(/^0x/, "");
  if (cleaned.length % 2 !== 0) cleaned = "0" + cleaned;
  const buf = Buffer.from(cleaned, "hex");
  if (buf.length > 32) throw new Error("EVM address >32 bytes");
  const out = Buffer.alloc(32);
  buf.copy(out, 32 - buf.length); // right-align (EVM convention)
  return out;
}

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

(async () => {
  // Provider ---------------------------------------------------------------
  const conn = new Connection("https://solana-mainnet.g.alchemy.com/v2/NhUn5DbOXuljZZ2xciqQek0-NhYJnsD6", {
    commitment: "confirmed",
  });
  const payer = loadKeypair(process.env.ANCHOR_WALLET!);
  const provider = new AnchorProvider(conn, new Wallet(payer), {
    commitment: "confirmed",
    skipPreflight: false,
  });
  anchor.setProvider(provider);

  // Workspace program – IDL generated by Anchor build ----------------------
  const smProgram = (anchor.workspace as any).LayerZeroShareMover as Program<any>;

  // ─── PDA derivations ────────────────────────────────────────────────────
  const shareMoverSeed = Buffer.from("share_mover");
  const [shareMoverPda] = PublicKey.findProgramAddressSync(
    [shareMoverSeed, SHARE_MINT.toBuffer()],
    SHARE_MOVER_PROGRAM_ID
  );

  const peerSeed = Buffer.from("Peer");

  const dstEidBe = new Uint8Array(4);
  new DataView(dstEidBe.buffer).setUint32(0, DST_EID, false);
  const [peerPda] = PublicKey.findProgramAddressSync(
    [peerSeed, shareMoverPda.toBuffer(), dstEidBe],
    SHARE_MOVER_PROGRAM_ID
  );

  const endpointSeed = Buffer.from("Endpoint");
  const [endpointSettingsPda] = PublicKey.findProgramAddressSync(
    [endpointSeed],
    ENDPOINT_PROGRAM_ID
  );

  const receiverBuf = padRecipient(RECEIVER_EVM_ADDRESS);
  const nonceSeed = Buffer.from("Nonce");
  const [noncePda] = PublicKey.findProgramAddressSync(
    [nonceSeed, shareMoverPda.toBuffer(), dstEidBe, receiverBuf],
    ENDPOINT_PROGRAM_ID
  );

  // Event authority PDA ----------------------------------------------------
  const eventSeed = Buffer.from("__event_authority");
  const [eventAuthorityPda] = PublicKey.findProgramAddressSync(
    [eventSeed],
    ENDPOINT_PROGRAM_ID
  );


  const [eventAuthorityPdaForUNLSend] = PublicKey.findProgramAddressSync(
    [eventSeed],
    SEND_LIBRARY_PROGRAM_ID
  );

  const oappSeed = Buffer.from("OApp");
  const [oappRegistryPda] = PublicKey.findProgramAddressSync([
    oappSeed,
    shareMoverPda.toBuffer(),
  ], ENDPOINT_PROGRAM_ID);

  // Placeholder payload_hash PDA (nonce 0) for fee-payment list
  const phSeed = Buffer.from("PayloadHash");
  const zeroNonceBuf = Buffer.alloc(8);
  const [payloadHashPda] = PublicKey.findProgramAddressSync([
    phSeed,
    shareMoverPda.toBuffer(),
    dstEidBe,
    receiverBuf,
    zeroNonceBuf,
  ], ENDPOINT_PROGRAM_ID);

  console.log("shareMoverPda", shareMoverPda.toBase58());
  
  // Send-library PDAs ------------------------------------------------------
  const sendLibConfigSeed = Buffer.from("SendLibraryConfig");
  const [sendLibraryConfigPda] = PublicKey.findProgramAddressSync(
    [sendLibConfigSeed, shareMoverPda.toBuffer(), dstEidBe],
    ENDPOINT_PROGRAM_ID
  );

  console.log("sendLibraryConfigPda", sendLibraryConfigPda.toBase58());

  const [defaultSendLibraryConfigPda] = PublicKey.findProgramAddressSync(
    [sendLibConfigSeed, dstEidBe],
    ENDPOINT_PROGRAM_ID
  );

  // fetch the 

  console.log("defaultSendLibraryConfigPda", defaultSendLibraryConfigPda.toBase58());
  const msgLibSeed = Buffer.from("MessageLib");

  const chosenLib = new PublicKey("2XgGZG4oP29U3w5h4nTk1V2LFHL23zKDPJjs3psGzLKQ");

  const [sendLibraryInfoPda] = PublicKey.findProgramAddressSync(
    [msgLibSeed, chosenLib.toBytes()],
    ENDPOINT_PROGRAM_ID
  );

  console.log("sendLibraryInfoPda", sendLibraryInfoPda.toBase58());

  // Vault-related PDAs -----------------------------------------------------
  const vaultStateSeed = Buffer.from("boring-vault-state");
  const vaultIdBuf = Buffer.alloc(8);
  vaultIdBuf.writeBigUInt64LE(VAULT_ID);
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [vaultStateSeed, vaultIdBuf],
    BORING_VAULT_PROGRAM_ID
  );

  const shareTokenSeed = Buffer.from("share-token");
  const [shareMintPda] = PublicKey.findProgramAddressSync(
    [shareTokenSeed, vaultPda.toBuffer()],
    BORING_VAULT_PROGRAM_ID
  );

  const ata = getAssociatedTokenAddressSync(
    SHARE_MINT,
    payer.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  // ─── Assemble send params ──────────────────────────────────────────────
  const sendParams = {
    dstEid: DST_EID,
    recipient: Array.from(receiverBuf),
    amount: new BN(AMOUNT_SHARES.toString()),
    options: hexBuf(OPTIONS_HEX),
    nativeFee: new BN(NATIVE_FEE_LAMPORTS.toString()),
    lzTokenFee: new BN(LZ_TOKEN_FEE.toString()),
  } as any;

  // Required base accounts -------------------------------------------------
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

  // ---------- executor / dvn config PDAs -----------------------------------
  const [executorConfigPda] = PublicKey.findProgramAddressSync(
    [EXECUTOR_CFG_SEED],
    SEND_LIBRARY_PROGRAM_ID
  );

  console.log("executorConfigPda", executorConfigPda.toBase58());

  const [dvnConfigPda] = PublicKey.findProgramAddressSync(
    [DVN_CFG_SEED, dstEidBe],
    DVN_PROGRAM_ID
  );

  // ---------- ULN PDAs ------------------------------------------------------
  const [ulnPda] = PublicKey.findProgramAddressSync([
    ULN_SEED,
  ], SEND_LIBRARY_PROGRAM_ID);

  const [sendConfigPda] = PublicKey.findProgramAddressSync([
    SEND_CFG_SEED,
    dstEidBe,
    shareMoverPda.toBuffer(),
  ], chosenLib);

  const [defaultSendConfigPda] = PublicKey.findProgramAddressSync([
    SEND_CFG_SEED,
    dstEidBe,
  ], chosenLib);

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
  console.log("------------------------------------------------------------------\n");

  // ─── Build & send transaction ------------------------------------------
  console.log("Calling ShareMover::send …");
  // Cast to `any` to prevent deep generic type instantiation issues in TS
  const ix = await (smProgram as any).methods
    .send(sendParams)
    .accounts(baseAccounts)
    .remainingAccounts(remain)
    .signers([payer])
    .instruction();

  const modifyCU = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
  const tx = new Transaction({ feePayer: payer.publicKey })
    .add(modifyCU)
    .add(ix);
  try {
    const sim = await provider.sendAndConfirm(tx, [payer]);
    console.log("✓ send tx:", sim);
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