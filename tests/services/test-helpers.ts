// tests/services/test-helpers.ts
import {
  BanksClient,
  ProgramTestContext,
  BanksTransactionResultWithMeta,
  Clock,
} from "solana-bankrun";
import {
  PublicKey,
  Transaction,
  Keypair,
  TransactionInstruction,
} from "@solana/web3.js";
import { ComputeBudgetProgram } from "@solana/web3.js";
import { Program } from "@coral-xyz/anchor";
import * as anchor from "@coral-xyz/anchor";
import { BoringVaultSvm } from "../../target/types/boring_vault_svm";
import {
  ACCOUNT_SIZE,
  AccountLayout,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { expect } from "chai";

export class TestHelperService {
  private static testTxNonce = 0;

  static async createAndProcessTransaction(
    client: BanksClient,
    payer: Keypair,
    instruction: TransactionInstruction,
    additionalSigners: Keypair[] = []
  ): Promise<BanksTransactionResultWithMeta> {
    const tx = new Transaction();
    const [latestBlockhash] = await client.getLatestBlockhash();
    tx.recentBlockhash = latestBlockhash;
    tx.feePayer = payer.publicKey;
    tx.add(instruction);
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({
        units: 1_400_000 + this.testTxNonce,
      })
    );
    tx.sign(payer, ...additionalSigners);

    this.testTxNonce++;
    return await client.tryProcessTransaction(tx);
  }

  static async setupATA(
    context: ProgramTestContext,
    programId: PublicKey,
    mintAccount: PublicKey,
    owner: PublicKey,
    amount: number,
    isWSol: boolean
  ): Promise<PublicKey> {
    const tokenAccData = Buffer.alloc(ACCOUNT_SIZE);
    const rentExempt = isWSol ? BigInt(2039280) : BigInt(0);

    AccountLayout.encode(
      {
        mint: mintAccount,
        owner,
        amount: BigInt(amount),
        delegateOption: 0,
        delegate: PublicKey.default,
        delegatedAmount: BigInt(0),
        state: 1,
        isNativeOption: isWSol ? 1 : 0,
        isNative: isWSol ? rentExempt : BigInt(0),
        closeAuthorityOption: 0,
        closeAuthority: PublicKey.default,
      },
      tokenAccData
    );

    const ata = getAssociatedTokenAddressSync(
      mintAccount,
      owner,
      true,
      programId
    );
    const ataAccountInfo = {
      lamports: isWSol ? Number(rentExempt) + amount : 1_000_000_000,
      data: tokenAccData,
      owner: programId,
      executable: false,
    };

    context.setAccount(ata, ataAccountInfo);
    return ata;
  }

  static async wait(
    client: BanksClient,
    context: ProgramTestContext,
    seconds: number
  ) {
    const currentClock = await client.getClock();
    context.setClock(
      new Clock(
        currentClock.slot,
        currentClock.epochStartTimestamp,
        currentClock.epoch,
        currentClock.leaderScheduleEpoch,
        currentClock.unixTimestamp + BigInt(seconds)
      )
    );
  }

  static async getTokenBalance(
    client: BanksClient,
    tokenAccount: PublicKey
  ): Promise<bigint> {
    const account = await client.getAccount(tokenAccount);
    if (!account) throw new Error("Account not found");
    return AccountLayout.decode(account.data).amount;
  }

  static expectTxToSucceed(result: string) {
    expect(result).to.be.null;
  }

  static expectTxToFail(result: string, logs: string[], errorMessage: string) {
    expect(result).to.not.be.null;
    // Look through logs for our error
    const foundError = logs.some((log) =>
      log.toLowerCase().includes(errorMessage.toLowerCase())
    );

    expect(
      foundError,
      `AssertionError: Expected to find error "${errorMessage}" in logs:\n${logs
        .map((log) => `        ${log}`)
        .join("\n")}`
    ).to.be.true;
  }

  static async updateExchangeRateAndWait(
    program: Program<BoringVaultSvm>,
    client: BanksClient,
    context: ProgramTestContext,
    vaultId: anchor.BN,
    newExchangeRate: anchor.BN,
    exchangeRateProvider: Keypair,
    boringVaultStateAccount: PublicKey,
    boringVaultShareMint: PublicKey,
    deployer: Keypair,
    waitTimeInSeconds: number = 86400
  ): Promise<{
    feesOwed: bigint;
    platformFees: bigint;
    performanceFees: bigint;
  }> {
    const ix = await program.methods
      .updateExchangeRate(vaultId, newExchangeRate)
      .accounts({
        signer: exchangeRateProvider.publicKey,
        boringVaultState: boringVaultStateAccount,
        shareMint: boringVaultShareMint,
        clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
      })
      .instruction();

    const txResult = await this.createAndProcessTransaction(
      client,
      deployer,
      ix,
      [exchangeRateProvider]
    );

    this.expectTxToSucceed(txResult.result);
    await this.wait(client, context, waitTimeInSeconds);

    const logs = txResult.meta?.logMessages || [];
    const platformFeeLog = logs.find((log) =>
      log.includes("Platform fees owed:")
    );
    const performanceFeeLog = logs.find((log) =>
      log.includes("Performance fees owed:")
    );

    const platformFees = platformFeeLog
      ? BigInt(platformFeeLog.split("Program log: Platform fees owed: ")[1])
      : BigInt(0);
    const performanceFees = performanceFeeLog
      ? BigInt(
          performanceFeeLog.split("Program log: Performance fees owed: ")[1]
        )
      : BigInt(0);

    const vaultState = await program.account.boringVault.fetch(
      boringVaultStateAccount
    );

    return {
      feesOwed: BigInt(vaultState.teller.feesOwedInBaseAsset.toNumber()),
      platformFees,
      performanceFees,
    };
  }
}
