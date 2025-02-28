import {
  ComputeBudgetProgram,
  AddressLookupTableProgram,
  Keypair,
  Connection,
  Transaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import dotenv from "dotenv";

// Load env variables
dotenv.config();

const anchor = require("@coral-xyz/anchor");
const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const privateKeyString = process.env.DEV_0_PRIVATE_KEY;
if (!privateKeyString) {
  throw new Error("DEV_0_PRIVATE_KEY is not defined in the environment");
}

const privateKeyArray = bs58.decode(privateKeyString);
const user = Keypair.fromSecretKey(privateKeyArray);

const KAMINO_LEND_PROGRAM_ID = new anchor.web3.PublicKey(
  "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"
);

async function main() {
  try {
    const connection = new Connection(
      process.env.ANCHOR_PROVIDER_URL,
      "confirmed"
    );
    const currentSlot = await connection.getSlot();
    // Create lookup table for user
    const [lookupTableInst, lookupTableAddress] =
      AddressLookupTableProgram.createLookupTable({
        authority: user.publicKey,
        payer: user.publicKey,
        recentSlot: currentSlot,
      });

    const targetProgramId = KAMINO_LEND_PROGRAM_ID;

    const [userMetadataPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("user_meta"), // from https://github.com/Kamino-Finance/klend/blob/master/programs/klend/src/utils/seeds.rs#L7
        user.publicKey.toBuffer(),
      ],
      targetProgramId
    );

    // Create the instruction data for init_user_metadata
    const discriminator = Buffer.from("75a9b045c5170fa2", "hex");
    const initUserMetadataData = Buffer.concat([
      discriminator,
      lookupTableAddress.toBuffer(),
    ]);

    // Create the instruction
    const initUserMetadataIx = new anchor.web3.TransactionInstruction({
      programId: targetProgramId,
      keys: [
        { pubkey: user.publicKey, isSigner: true, isWritable: true }, // owner
        { pubkey: user.publicKey, isSigner: true, isWritable: true }, // fee_payer
        { pubkey: userMetadataPda, isSigner: false, isWritable: true }, // user_metadata
        { pubkey: targetProgramId, isSigner: false, isWritable: false }, // referrer_user_metadata
        {
          pubkey: anchor.web3.SYSVAR_RENT_PUBKEY,
          isSigner: false,
          isWritable: false,
        }, // rent
        {
          pubkey: anchor.web3.SystemProgram.programId,
          isSigner: false,
          isWritable: false,
        }, // system_program
      ],
      data: initUserMetadataData,
    });

    const tx = new Transaction();
    const latestBlockhash = await connection.getLatestBlockhash();
    tx.recentBlockhash = latestBlockhash.blockhash;
    tx.feePayer = user.publicKey;
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({
        units: 1_400_000,
      })
    );
    tx.add(lookupTableInst);
    tx.add(initUserMetadataIx);
    tx.sign(user);

    // Send the transaction
    const txSignature = await connection.sendTransaction(tx, [user]);
    console.log("Transaction sent with signature:", txSignature);

    // Confirm the transaction
    const confirmation = await connection.confirmTransaction(
      txSignature,
      "confirmed"
    );
    console.log("Transaction confirmed:", confirmation);
  } catch (error) {
    console.error("Init Oblgiation Failed: ", error);
    throw error;
  }
}

main();
