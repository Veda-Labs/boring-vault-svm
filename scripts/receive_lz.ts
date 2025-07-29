import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, Transaction, AccountMeta, ComputeBudgetProgram } from "@solana/web3.js";
import "dotenv/config";
import fs from "fs";
import BN from "bn.js";
import { LayerZeroShareMover } from "../target/types/layer_zero_share_mover";
import * as borsh from "@coral-xyz/borsh";

// ─── Fill from LayerZero Scan ─────────────────────────────────────────
const SRC_EID = 30214;
const SENDER_BYTES32 = "0x000000000000000000000000c1caf4915849cd5fe21efaa4ae14e4eafa7a3431";
const NONCE = 6n;
const GUID_HEX = "0xa97ae0341df1ecc5696bbdc15d695ddf2df4c046c6bce16cac0948f2473fca98";      // 32-byte guid
const MESSAGE_HEX = "0xaa118f46fd933a74befe80395d1ddb2a094a77ca078de0070fe4e74af6c42821000000000000000000000000000f4240";   // payload bytes
const EXTRA_HEX = "0x";      // usually 0x
// ─── Program constants on Solana ─────────────────────────────────────
const ENDPOINT_PID = new PublicKey("76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6");
const SHARE_MINT  = new PublicKey("88ZgQ7nKQeAHV7Q4ivAT7QaeabCzSpuKa8T8PNRaAm4e");
const SHARE_MOVER_PROGRAM = new PublicKey("CU9XermEoiawu8eYwSyXBHgMESRwWEycDU9jjk9MHSgN");
// ─────────────────────────────────────────────────────────────────────

const anchor = require("@coral-xyz/anchor");

function hexBuf(h: string) { return Buffer.from(h.replace(/^0x/, ""), "hex"); }

(async () => {
  // provider ------------------------------------------------------------
  const conn = new Connection(process.env.ANCHOR_PROVIDER_URL!, { commitment: "confirmed"});
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.ANCHOR_WALLET!, "utf8"))));
  const provider = new AnchorProvider(conn, new Wallet(payer), { skipPreflight: true });
  anchor.setProvider(provider);

  // workspace program instance (IDL already loaded by Anchor)
  const smProgram: any = anchor.workspace.LayerZeroShareMover as Program<LayerZeroShareMover>;

  // derive PDAs ---------------------------------------------------------
  const [shareMoverPda] = PublicKey.findProgramAddressSync([
    Buffer.from("share_mover"), SHARE_MINT.toBuffer()
  ], SHARE_MOVER_PROGRAM);

  // Call lz_receive_types (view) ---------------------------------------
  const msgBuf = hexBuf(MESSAGE_HEX);
  if (msgBuf.length !== 48) throw new Error(`ShareBridge message must be 48 bytes, got ${msgBuf.length}`);

  // Let's debug what Anchor is actually sending
  console.log("=== Debug Info ===");
  console.log("Message buffer:", msgBuf);
  console.log("Message hex:", msgBuf.toString('hex'));
  console.log("Extra data buffer:", hexBuf(EXTRA_HEX));

  // Build params - trying different approaches
  const lzParams = {
    srcEid: SRC_EID,
    sender: Array.from(hexBuf(SENDER_BYTES32)),
    nonce: new BN(NONCE.toString()),
    guid: Array.from(hexBuf(GUID_HEX)),
    message: msgBuf,
    extraData: hexBuf(EXTRA_HEX),
  };

  // First, let's see what Anchor generates
  try {
    const ix = await smProgram.methods
      .lzReceiveTypes(lzParams)
      .accounts({ store: shareMoverPda })
      .instruction();
    
    console.log("\n=== Anchor-generated instruction ===");
    console.log("Instruction data length:", ix.data.length);
    console.log("Instruction data hex:", ix.data.toString('hex'));
    
    // Let's examine the data byte by byte
    let offset = 0;
    console.log("\n=== Data breakdown ===");
    console.log("Discriminator (8 bytes):", ix.data.subarray(offset, offset + 8).toString('hex'));
    offset += 8;
    
    console.log("src_eid (4 bytes):", ix.data.subarray(offset, offset + 4).toString('hex'), "=>", ix.data.readUInt32LE(offset));
    offset += 4;
    
    console.log("sender (32 bytes):", ix.data.subarray(offset, offset + 32).toString('hex'));
    offset += 32;
    
    console.log("nonce (8 bytes):", ix.data.subarray(offset, offset + 8).toString('hex'));
    offset += 8;
    
    console.log("guid (32 bytes):", ix.data.subarray(offset, offset + 32).toString('hex'));
    offset += 32;
    
    // Vec<u8> for message
    const messageLen = ix.data.readUInt32LE(offset);
    console.log("message length (4 bytes):", ix.data.subarray(offset, offset + 4).toString('hex'), "=>", messageLen);
    offset += 4;
    
    console.log("message data:", ix.data.subarray(offset, offset + messageLen).toString('hex'));
    offset += messageLen;
    
    // Vec<u8> for extra_data
    const extraLen = ix.data.readUInt32LE(offset);
    console.log("extra_data length (4 bytes):", ix.data.subarray(offset, offset + 4).toString('hex'), "=>", extraLen);
    offset += 4;
    
    if (extraLen > 0) {
      console.log("extra_data:", ix.data.subarray(offset, offset + extraLen).toString('hex'));
    }
    
    // Now simulate
    const simRes = await conn.simulateTransaction(
      new Transaction({ feePayer: payer.publicKey }).add(ix),
      [payer]
    );

    if (simRes.value.err) {
      console.log("\n=== Simulation failed ===");
      console.log("Error:", simRes.value.err);
      console.log("Logs:", simRes.value.logs);
      
      // Let's check the account data
      const accountInfo = await conn.getAccountInfo(shareMoverPda);
      if (accountInfo) {
        console.log("\n=== Account info ===");
        console.log("Account owner:", accountInfo.owner.toString());
        console.log("Account data length:", accountInfo.data.length);
        console.log("First 100 bytes:", accountInfo.data.subarray(0, 100).toString('hex'));
      }
    } else {
      console.log("\n=== Simulation succeeded! ===");
      const ret = simRes.value.returnData;
      if (ret) {
        const raw = Buffer.from(ret.data[0], "base64");  // Note: ret.data[0], not ret[0]
        console.log("Return data:", raw.toString('hex'));
        
        const vecLength = raw.readUInt32LE(0);
        console.log("Number of accounts in response:", vecLength);
        
        const accounts: AccountMeta[] = [];
        let offset = 4;
        
        for (let i = 0; i < vecLength; i++) {
          const pubkeyBytes = raw.slice(offset, offset + 32);
          const pubkey = new PublicKey(pubkeyBytes);
          const isSigner = raw[offset + 32] === 1;
          const isWritable = raw[offset + 33] === 1;
          
          accounts.push({
            pubkey,
            isSigner: false,
            isWritable,
          });
          
          offset += 34;
        }

        console.log("accounts", accounts.length);

        const ix = await smProgram.methods
        .lzReceive(lzParams)
        .accounts({
          shareMover: accounts[0].pubkey,
          peer: accounts[1].pubkey,
        })
        .remainingAccounts(accounts.slice(2)) // Pass the rest as remaining accounts
        .instruction();

        console.log("lzReceive transaction:", ix);

        const cuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 350000 });

        const sim = await provider.connection.simulateTransaction(
          new Transaction().add(cuIx).add(ix),
          [payer],
          true,
        );

        console.log("simulated transaction:", sim);
        
        const tx = new Transaction({ feePayer: payer.publicKey }).add(cuIx).add(ix);

        const sig = await provider.sendAndConfirm(tx, [payer]);
        console.log("lzReceive transaction:", sig);
      
      }
    }

  } catch (error) {
    console.error("Error:", error);
  }
})();