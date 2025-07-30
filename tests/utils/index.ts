import * as anchor from "@coral-xyz/anchor";
import { ProgramTestContext } from "solana-bankrun";

export * from "./seeds";

export const fundAccount = async (
  context: ProgramTestContext,
  account: anchor.web3.Keypair,
  amount: number
): Promise<void> => {
  await context.setAccount(account.publicKey, {
    lamports: amount,
    data: Buffer.alloc(0),
    owner: anchor.web3.SystemProgram.programId,
    executable: false,
    rentEpoch: 0,
  });
};

export const createStubTokenMint = (
  mintAuthority: anchor.web3.PublicKey,
  decimals: number
): Buffer => {
  const buf = Buffer.alloc(82);
  buf.writeUInt32LE(1, 0); // mint_authority option = Some
  mintAuthority.toBuffer().copy(buf, 4);
  buf.writeBigUInt64LE(0n, 36); // supply = 0
  buf.writeUInt8(decimals, 44);
  buf.writeUInt8(1, 45); // is_initialized = true
  buf.writeUInt8(0, 46); // freeze_authority option = None
  return buf;
};
