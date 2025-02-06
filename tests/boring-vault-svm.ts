import * as anchor from "@coral-xyz/anchor";
import { BankrunProvider, startAnchor } from "anchor-bankrun";
import { Program } from "@coral-xyz/anchor";
import { BoringVaultSvm } from "../target/types/boring_vault_svm";
import { MockKaminoLend } from "../target/types/mock_kamino_lend";
import { BoringOnchainQueue } from "../target/types/boring_onchain_queue";
import { expect } from "chai";
import {
  ComputeBudgetProgram,
  AddressLookupTableProgram,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { AddedAccount, BanksClient, ProgramTestContext } from "solana-bankrun";
import { PublicKey, Transaction, Connection } from "@solana/web3.js";
import { CpiService, TestHelperService as ths } from "./services";
import bs58 from "bs58";

import dotenv from "dotenv";
dotenv.config();

describe("boring-vault-svm", () => {
  let provider: BankrunProvider;
  let program: Program<BoringVaultSvm>;
  let mockKaminoLendProgram: Program<MockKaminoLend>;
  let queueProgram: Program<BoringOnchainQueue>;
  let context: ProgramTestContext;
  let client: BanksClient;
  let connection: Connection;

  let deployer: anchor.web3.Keypair;
  let authority: anchor.web3.Keypair = anchor.web3.Keypair.generate();
  let newAuthority: anchor.web3.Keypair = anchor.web3.Keypair.generate();
  let strategist: anchor.web3.Keypair = anchor.web3.Keypair.generate();
  let user: anchor.web3.Keypair = anchor.web3.Keypair.generate();
  let payout: anchor.web3.Keypair = anchor.web3.Keypair.generate();

  let programConfigAccount: anchor.web3.PublicKey;
  let boringVaultStateAccount: anchor.web3.PublicKey;
  let boringVaultAccount: anchor.web3.PublicKey;
  let boringVaultShareMint: anchor.web3.PublicKey;
  let userJitoSolAta: anchor.web3.PublicKey;
  let authJitoSolAta: anchor.web3.PublicKey;
  let payoutJitoSolAta: anchor.web3.PublicKey;
  let vaultJitoSolAta: anchor.web3.PublicKey;
  let queueJitoSolAta: anchor.web3.PublicKey;
  let jitoSolAssetDataPda: anchor.web3.PublicKey;
  let solAssetDataPda: anchor.web3.PublicKey;
  let userShareAta: anchor.web3.PublicKey;
  let vaultWSolAta: anchor.web3.PublicKey;
  let queueStateAccount: anchor.web3.PublicKey;
  let queueProgramConfigAccount: anchor.web3.PublicKey;
  let queueAccount: anchor.web3.PublicKey;
  let jitoSolWithdrawAssetData: anchor.web3.PublicKey;
  let userWithdrawState: anchor.web3.PublicKey;
  let userWithdrawRequest: anchor.web3.PublicKey;
  let queueShareAta: anchor.web3.PublicKey;
  let cpiDigestAccount: anchor.web3.PublicKey;

  const PROJECT_DIRECTORY = "";
  const STAKE_POOL_PROGRAM_ID = new anchor.web3.PublicKey(
    "SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy"
  );
  const JITO_SOL_STAKE_POOL = new anchor.web3.PublicKey(
    "Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb"
  );
  const JITO_SOL_STAKE_POOL_WITHDRAW_AUTH = new anchor.web3.PublicKey(
    "6iQKfEyhr3bZMotVkW6beNZz5CPAkiwvgV2CTje9pVSS"
  );
  const JITO_SOL_STAKE_POOL_RESERVE = new anchor.web3.PublicKey(
    "BgKUXdS29YcHCFrPm5M8oLHiTzZaMDjsebggjoaQ6KFL"
  );
  const JITO_SOL_STAKE_POOL_FEE = new anchor.web3.PublicKey(
    "feeeFLLsam6xZJFc6UQFrHqkvVt4jfmVvi2BRLkUZ4i"
  );

  const JITOSOL_SOL_ORACLE = new anchor.web3.PublicKey(
    "4Z1SLH9g4ikNBV8uP2ZctEouqjYmVqB2Tz5SZxKYBN7z"
  );
  const JITOSOL = new anchor.web3.PublicKey(
    "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn"
  );

  const ADDRESS_LOOKUP_TABLE_PROGRAM_ID = new anchor.web3.PublicKey(
    "AddressLookupTab1e1111111111111111111111111"
  );

  const KAMINO_LEND_PROGRAM_ID = new anchor.web3.PublicKey(
    "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"
  );
  const KAMINO_LEND_JITO_SOL_OBLIGATION = new anchor.web3.PublicKey(
    "95XivWGu4By7b7B6upK5ThXrYSsKKtNGrcpcgucTStNU"
  );
  const KAMINO_LEND_JITO_SOL_MARKET = new anchor.web3.PublicKey(
    "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF"
  );

  const WSOL = new anchor.web3.PublicKey(
    "So11111111111111111111111111111111111111112"
  );

  const ACCOUNTS_TO_CLONE = [
    JITO_SOL_STAKE_POOL.toString(),
    JITO_SOL_STAKE_POOL_WITHDRAW_AUTH.toString(),
    JITO_SOL_STAKE_POOL_RESERVE.toString(),
    JITO_SOL_STAKE_POOL_FEE.toString(),
    JITOSOL_SOL_ORACLE.toString(),
    JITOSOL.toString(),
    WSOL.toString(),
    KAMINO_LEND_JITO_SOL_OBLIGATION.toString(),
    KAMINO_LEND_JITO_SOL_MARKET.toString(),
  ];

  before(async () => {
    connection = new Connection(
      `https://solana-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
    );
    // connection = new Connection(`https://api.mainnet-beta.solana.com`);

    // Helper function to create AddedAccount from public key
    const createAddedAccount = async (
      pubkeyStr: string
    ): Promise<AddedAccount> => {
      const pubkey = new PublicKey(pubkeyStr);
      const accountInfo = await connection.getAccountInfo(pubkey);
      if (!accountInfo) throw new Error(`Failed to fetch account ${pubkeyStr}`);
      return {
        address: pubkey,
        info: accountInfo,
      };
    };

    // Create base accounts for deployer, and authority.
    const baseAccounts: AddedAccount[] = [
      {
        address: authority.publicKey,
        info: {
          lamports: 2_000_000_000,
          data: Buffer.alloc(0),
          owner: anchor.web3.SystemProgram.programId,
          executable: false,
        },
      },
      {
        address: strategist.publicKey,
        info: {
          lamports: 2_000_000_000,
          data: Buffer.alloc(0),
          owner: anchor.web3.SystemProgram.programId,
          executable: false,
        },
      },
      {
        address: user.publicKey,
        info: {
          lamports: 100_000_000_000,
          data: Buffer.alloc(0),
          owner: anchor.web3.SystemProgram.programId,
          executable: false,
        },
      },
      {
        address: newAuthority.publicKey,
        info: {
          lamports: 100_000_000_000,
          data: Buffer.alloc(0),
          owner: anchor.web3.SystemProgram.programId,
          executable: false,
        },
      },
    ];

    // Fetch all accounts in parallel
    const clonedAccounts = await Promise.all(
      ACCOUNTS_TO_CLONE.map(createAddedAccount)
    );

    // Combine base accounts with cloned accounts
    const allAccounts = [...baseAccounts, ...clonedAccounts];

    // Setup bankrun context
    context = await startAnchor(
      PROJECT_DIRECTORY,
      [
        {
          name: "sol_stake_pool",
          programId: STAKE_POOL_PROGRAM_ID,
        },
        {
          name: "kamino_lend",
          programId: KAMINO_LEND_PROGRAM_ID,
        },
      ],
      allAccounts
    );
    client = context.banksClient;
    provider = new BankrunProvider(context);
    deployer = context.payer;
    anchor.setProvider(provider);

    program = anchor.workspace.BoringVaultSvm as Program<BoringVaultSvm>;
    mockKaminoLendProgram = anchor.workspace
      .MockKaminoLend as Program<MockKaminoLend>;
    queueProgram = anchor.workspace
      .BoringOnchainQueue as Program<BoringOnchainQueue>;
    // Find PDAs
    let bump;
    [programConfigAccount, bump] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    [boringVaultStateAccount, bump] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("boring-vault-state"), Buffer.from(new Array(8).fill(0))],
        program.programId
      );

    [boringVaultAccount, bump] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("boring-vault"),
        Buffer.from(new Array(8).fill(0)),
        Buffer.from([0]),
      ],
      program.programId
    );

    [boringVaultShareMint, bump] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("share-token"), boringVaultStateAccount.toBuffer()],
      program.programId
    );

    [jitoSolAssetDataPda, bump] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("asset-data"),
        boringVaultStateAccount.toBuffer(),
        JITOSOL.toBuffer(),
      ],
      program.programId
    );

    [solAssetDataPda, bump] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("asset-data"),
        boringVaultStateAccount.toBuffer(),
        anchor.web3.PublicKey.default.toBuffer(),
      ],
      program.programId
    );

    userJitoSolAta = await ths.setupATA(
      context,
      TOKEN_PROGRAM_ID,
      JITOSOL,
      user.publicKey,
      1000000000000000000,
      false
    );
    authJitoSolAta = await ths.setupATA(
      context,
      TOKEN_PROGRAM_ID,
      JITOSOL,
      authority.publicKey,
      0,
      false
    );
    vaultJitoSolAta = await ths.setupATA(
      context,
      TOKEN_PROGRAM_ID,
      JITOSOL,
      boringVaultAccount,
      1000000000,
      false
    ); // 1 JitoSOL
    userShareAta = await ths.setupATA(
      context,
      TOKEN_2022_PROGRAM_ID,
      boringVaultShareMint,
      user.publicKey,
      0,
      false
    );
    vaultWSolAta = await ths.setupATA(
      context,
      TOKEN_PROGRAM_ID,
      WSOL,
      boringVaultAccount,
      1000000000,
      true
    ); // Start with 1 wSOL.

    payoutJitoSolAta = await ths.setupATA(
      context,
      TOKEN_PROGRAM_ID,
      JITOSOL,
      payout.publicKey,
      0,
      false
    );

    // Queue PDAs
    [queueProgramConfigAccount, bump] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("config")],
        queueProgram.programId
      );
    [queueStateAccount, bump] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("boring-queue-state"), Buffer.from(new Array(8).fill(0))],
      queueProgram.programId
    );

    [queueAccount, bump] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("boring-queue"), Buffer.from(new Array(8).fill(0))],
      queueProgram.programId
    );

    [jitoSolWithdrawAssetData, bump] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [
          Buffer.from("boring-queue-withdraw-asset-data"),
          JITOSOL.toBuffer(),
          Buffer.from(new Array(8).fill(0)),
        ],
        queueProgram.programId
      );

    [userWithdrawState, bump] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("boring-queue-user-withdraw-state"),
        user.publicKey.toBuffer(),
      ],
      queueProgram.programId
    );

    queueShareAta = await ths.setupATA(
      context,
      TOKEN_2022_PROGRAM_ID,
      boringVaultShareMint,
      queueAccount,
      0,
      false
    );
    queueJitoSolAta = await ths.setupATA(
      context,
      TOKEN_PROGRAM_ID,
      JITOSOL,
      queueAccount,
      0,
      false
    );
  });

  it("Is initialized", async () => {
    const ix = await program.methods
      .initialize(authority.publicKey)
      .accounts({
        // @ts-ignore
        config: programConfigAccount,
        signer: deployer.publicKey,
      })
      .instruction();

    let txResult = await ths.createAndProcessTransaction(client, deployer, ix, [
      deployer,
    ]);

    // Expect the tx to succeed.
    ths.expectTxToSucceed(txResult.result);

    const programConfig = await program.account.programConfig.fetch(
      programConfigAccount
    );
    expect(programConfig.authority.equals(authority.publicKey)).to.be.true;
    expect(programConfig.vaultCount.toNumber()).to.equal(0);
  });

  it("Can deploy a vault", async () => {
    const ix = await program.methods
      .deploy({
        authority: authority.publicKey,
        name: "Boring Vault",
        symbol: "BV",
        exchangeRateProvider: strategist.publicKey,
        exchangeRate: new anchor.BN(1000000000),
        payoutAddress: payout.publicKey,
        allowedExchangeRateChangeUpperBound: 10050,
        allowedExchangeRateChangeLowerBound: 9950,
        minimumUpdateDelayInSeconds: 3600,
        platformFeeBps: 100,
        performanceFeeBps: 2000,
        strategist: strategist.publicKey,
        withdrawAuthority: anchor.web3.PublicKey.default, // permissionless
      })
      .accounts({
        // @ts-ignore
        config: programConfigAccount,
        boringVaultState: boringVaultStateAccount,
        shareMint: boringVaultShareMint,
        baseAsset: JITOSOL,
        signer: authority.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .instruction();

    let txResult = await ths.createAndProcessTransaction(client, deployer, ix, [
      authority,
    ]);

    // Expect the tx to succeed.
    ths.expectTxToSucceed(txResult.result);

    const programConfig = await program.account.programConfig.fetch(
      programConfigAccount
    );
    expect(programConfig.vaultCount.toNumber()).to.equal(1);

    const boringVault = await program.account.boringVault.fetch(
      boringVaultStateAccount
    );
    expect(boringVault.config.vaultId.toNumber()).to.equal(0);
    expect(boringVault.config.authority.equals(authority.publicKey)).to.be.true;
    expect(boringVault.config.shareMint.equals(boringVaultShareMint)).to.be
      .true;
    expect(boringVault.config.paused).to.be.false;
  });

  it("Can transfer authority", async () => {
    // Transfer authority to new authority.
    {
      const ix = await program.methods
        .transferAuthority(new anchor.BN(0), newAuthority.publicKey)
        .accounts({
          signer: authority.publicKey,
          boringVaultState: boringVaultStateAccount,
        })
        .instruction();

      let txResult = await ths.createAndProcessTransaction(
        client,
        deployer,
        ix,
        [authority]
      );

      // Expect the tx to succeed.
      ths.expectTxToSucceed(txResult.result);

      const boringVault = await program.account.boringVault.fetch(
        boringVaultStateAccount
      );
      expect(boringVault.config.pendingAuthority.equals(newAuthority.publicKey))
        .to.be.true;
    }

    // Now accept the authority.
    {
      const ix = await program.methods
        .acceptAuthority(new anchor.BN(0))
        .accounts({
          signer: newAuthority.publicKey,
          boringVaultState: boringVaultStateAccount,
        })
        .instruction();

      let txResult = await ths.createAndProcessTransaction(
        client,
        deployer,
        ix,
        [newAuthority]
      );

      // Expect the tx to succeed.
      ths.expectTxToSucceed(txResult.result);

      const boringVault = await program.account.boringVault.fetch(
        boringVaultStateAccount
      );
      expect(boringVault.config.authority.equals(newAuthority.publicKey)).to.be
        .true;
      expect(
        boringVault.config.pendingAuthority.equals(
          anchor.web3.PublicKey.default
        )
      ).to.be.true;
    }

    // Transfer authority back to original authority.
    {
      const ix = await program.methods
        .transferAuthority(new anchor.BN(0), authority.publicKey)
        .accounts({
          signer: newAuthority.publicKey,
          boringVaultState: boringVaultStateAccount,
        })
        .instruction();

      let txResult = await ths.createAndProcessTransaction(
        client,
        deployer,
        ix,
        [newAuthority]
      );

      // Expect the tx to succeed.
      ths.expectTxToSucceed(txResult.result);

      const boringVault = await program.account.boringVault.fetch(
        boringVaultStateAccount
      );
      expect(boringVault.config.pendingAuthority.equals(authority.publicKey)).to
        .be.true;
    }

    // Accept authority again.
    {
      const acceptIx = await program.methods
        .acceptAuthority(new anchor.BN(0))
        .accounts({
          signer: authority.publicKey,
          boringVaultState: boringVaultStateAccount,
        })
        .instruction();

      let txResult = await ths.createAndProcessTransaction(
        client,
        deployer,
        acceptIx,
        [authority]
      );

      // Expect the tx to succeed.
      ths.expectTxToSucceed(txResult.result);

      const boringVault = await program.account.boringVault.fetch(
        boringVaultStateAccount
      );
      expect(boringVault.config.authority.equals(authority.publicKey)).to.be
        .true;
      expect(
        boringVault.config.pendingAuthority.equals(
          anchor.web3.PublicKey.default
        )
      ).to.be.true;
    }
  });

  // TODO
  it("Can update asset data", async () => {
    const ix = await program.methods
      .updateAssetData({
        vaultId: new anchor.BN(0),
        assetData: {
          allowDeposits: true,
          allowWithdrawals: true,
          sharePremiumBps: 100,
          isPeggedToBaseAsset: true,
          priceFeed: anchor.web3.PublicKey.default,
          inversePriceFeed: false,
        },
      })
      .accounts({
        signer: authority.publicKey,
        boringVaultState: boringVaultStateAccount,
        // @ts-ignore
        systemProgram: anchor.web3.SystemProgram.programId,
        asset: JITOSOL,
        assetData: jitoSolAssetDataPda,
      })
      .instruction();

    let txResult = await ths.createAndProcessTransaction(client, deployer, ix, [
      authority,
    ]);

    // Expect the tx to succeed.
    ths.expectTxToSucceed(txResult.result);

    const assetData = await program.account.assetData.fetch(
      jitoSolAssetDataPda
    );
    expect(assetData.allowDeposits).to.be.true;
    expect(assetData.allowWithdrawals).to.be.true;
    expect(assetData.sharePremiumBps).to.equal(100);
    expect(assetData.isPeggedToBaseAsset).to.be.true;
    expect(assetData.priceFeed.equals(anchor.web3.PublicKey.default)).to.be
      .true;
    expect(assetData.inversePriceFeed).to.be.false;

    // Update JitoSol asset data again
    const ix_0 = await program.methods
      .updateAssetData({
        vaultId: new anchor.BN(0),
        assetData: {
          allowDeposits: true,
          allowWithdrawals: true,
          sharePremiumBps: 0,
          isPeggedToBaseAsset: true,
          priceFeed: anchor.web3.PublicKey.default,
          inversePriceFeed: false,
        },
      })
      .accounts({
        signer: authority.publicKey,
        boringVaultState: boringVaultStateAccount,
        // @ts-ignore
        systemProgram: anchor.web3.SystemProgram.programId,
        asset: JITOSOL,
        assetData: jitoSolAssetDataPda,
      })
      .instruction();

    let txResult_0 = await ths.createAndProcessTransaction(
      client,
      deployer,
      ix_0,
      [authority]
    );

    // Expect the tx to succeed.
    ths.expectTxToSucceed(txResult_0.result);

    // Make sure changes took affect.
    const assetDataAfterUpdate = await program.account.assetData.fetch(
      jitoSolAssetDataPda
    );
    expect(assetDataAfterUpdate.allowDeposits).to.be.true;
    expect(assetDataAfterUpdate.allowWithdrawals).to.be.true;
    expect(assetDataAfterUpdate.sharePremiumBps).to.equal(0);
    expect(assetDataAfterUpdate.isPeggedToBaseAsset).to.be.true;
    expect(assetDataAfterUpdate.priceFeed.equals(anchor.web3.PublicKey.default))
      .to.be.true;
    expect(assetDataAfterUpdate.inversePriceFeed).to.be.false;
  });

  it("Can deposit SOL into a vault", async () => {
    const ix_0 = await program.methods
      .updateAssetData({
        vaultId: new anchor.BN(0),
        assetData: {
          allowDeposits: true,
          allowWithdrawals: true,
          sharePremiumBps: 0,
          isPeggedToBaseAsset: false,
          priceFeed: JITOSOL_SOL_ORACLE,
          inversePriceFeed: true,
        },
      })
      .accounts({
        signer: authority.publicKey,
        boringVaultState: boringVaultStateAccount,
        // @ts-ignore
        systemProgram: anchor.web3.SystemProgram.programId,
        asset: anchor.web3.PublicKey.default,
        assetData: solAssetDataPda,
      })
      .instruction();

    let txResult_0 = await ths.createAndProcessTransaction(
      client,
      deployer,
      ix_0,
      [authority]
    );

    // Expect the tx to succeed.
    ths.expectTxToSucceed(txResult_0.result);

    let depositAmount = new anchor.BN(1000000000);
    const ix_1 = await program.methods
      .depositSol({
        vaultId: new anchor.BN(0),
        depositAmount: depositAmount,
        minMintAmount: new anchor.BN(0),
      })
      .accounts({
        // @ts-ignore
        signer: user.publicKey,
        // @ts-ignore
        tokenProgram2022: TOKEN_2022_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        boringVaultState: boringVaultStateAccount,
        boringVault: boringVaultAccount,
        assetData: solAssetDataPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        shareMint: boringVaultShareMint,
        userShares: userShareAta,
        priceFeed: JITOSOL_SOL_ORACLE,
      })
      .instruction();

    let userShareStartBalance = await ths.getTokenBalance(client, userShareAta);
    let userSolStartBalance = await client.getBalance(user.publicKey);
    let txResult_1 = await ths.createAndProcessTransaction(
      client,
      deployer,
      ix_1,
      [user]
    );

    // Expect the tx to succeed.
    ths.expectTxToSucceed(txResult_1.result);

    let userShareEndBalance = await ths.getTokenBalance(client, userShareAta);
    let userSolEndBalance = await client.getBalance(user.publicKey);
    expect(BigInt(userShareEndBalance - userShareStartBalance) > BigInt(0));
    expect(
      BigInt(userShareEndBalance - userShareStartBalance) < BigInt(1000000000)
    );
    expect((userSolStartBalance - userSolEndBalance).toString()).to.equal(
      depositAmount.toString()
    );
  });

  it("Can deposit JitoSOL into a vault", async () => {
    let depositAmount = new anchor.BN(1000000000);
    const ix_1 = await program.methods
      .deposit({
        vaultId: new anchor.BN(0),
        depositAmount: depositAmount,
        minMintAmount: new anchor.BN(0),
      })
      .accounts({
        // @ts-ignore
        signer: user.publicKey,
        boringVaultState: boringVaultStateAccount,
        boringVault: boringVaultAccount,
        depositMint: JITOSOL,
        // @ts-ignore
        assetData: jitoSolAssetDataPda,
        userAta: userJitoSolAta,
        vaultAta: vaultJitoSolAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        tokenProgram2022: TOKEN_2022_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        shareMint: boringVaultShareMint,
        userShares: userShareAta,
        priceFeed: anchor.web3.PublicKey.default,
      })
      .instruction();

    let userShareStartBalance = await ths.getTokenBalance(client, userShareAta);
    let userJitoSolStartBalance = await ths.getTokenBalance(
      client,
      userJitoSolAta
    );
    let vaultJitoSolStartBalance = await ths.getTokenBalance(
      client,
      vaultJitoSolAta
    );

    let txResult_1 = await ths.createAndProcessTransaction(
      client,
      deployer,
      ix_1,
      [user]
    );

    // Expect the tx to succeed.
    ths.expectTxToSucceed(txResult_1.result);

    // We expect this to be 1 share larger because of the previous deposit.
    let userShareEndBalance = await ths.getTokenBalance(client, userShareAta);
    let userJitoSolEndBalance = await ths.getTokenBalance(
      client,
      userJitoSolAta
    );
    let vaultJitoSolEndBalance = await ths.getTokenBalance(
      client,
      vaultJitoSolAta
    );
    expect(
      BigInt(userShareEndBalance - userShareStartBalance) == BigInt(1000000000)
    ); // Should mint 1 share since JitoSol is base
    expect(
      (userJitoSolStartBalance - userJitoSolEndBalance).toString()
    ).to.equal(depositAmount.toString());
    expect(
      (vaultJitoSolEndBalance - vaultJitoSolStartBalance).toString()
    ).to.equal(depositAmount.toString());
  });

  it("Can withdraw JitoSOL from the vault", async () => {
    let withdraw_amount = new anchor.BN(1_000_000_000);
    const withdraw_ix = await program.methods
      .withdraw({
        vaultId: new anchor.BN(0),
        shareAmount: withdraw_amount,
        minAssetsAmount: new anchor.BN(0),
      })
      .accounts({
        signer: user.publicKey,
        boringVaultState: boringVaultStateAccount,
        boringVault: boringVaultAccount,
        withdrawMint: JITOSOL,
        // @ts-ignore
        assetData: jitoSolAssetDataPda,
        userAta: userJitoSolAta,
        vaultAta: vaultJitoSolAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        tokenProgram2022: TOKEN_2022_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        shareMint: boringVaultShareMint,
        userShares: userShareAta,
        priceFeed: anchor.web3.PublicKey.default,
      })
      .instruction();

    let userShareStartBalance = await ths.getTokenBalance(client, userShareAta);
    let userJitoSolStartBalance = await ths.getTokenBalance(
      client,
      userJitoSolAta
    );
    let vaultJitoSolStartBalance = await ths.getTokenBalance(
      client,
      vaultJitoSolAta
    );

    let txResult_1 = await ths.createAndProcessTransaction(
      client,
      deployer,
      withdraw_ix,
      [user]
    );

    // Expect the tx to succeed.
    ths.expectTxToSucceed(txResult_1.result);

    let userShareEndBalance = await ths.getTokenBalance(client, userShareAta);
    let userJitoSolEndBalance = await ths.getTokenBalance(
      client,
      userJitoSolAta
    );
    let vaultJitoSolEndBalance = await ths.getTokenBalance(
      client,
      vaultJitoSolAta
    );
    expect(
      BigInt(userShareStartBalance - userShareEndBalance) == BigInt(1000000000)
    ); // Should burned 1 share since JitoSol is base
    expect(
      (userJitoSolEndBalance - userJitoSolStartBalance).toString()
    ).to.equal(withdraw_amount.toString());
    expect(
      (vaultJitoSolStartBalance - vaultJitoSolEndBalance).toString()
    ).to.equal(withdraw_amount.toString());
  });

  it("Can update exchange rate and calculate fees owed", async () => {
    await ths.wait(client, context, 86_400);

    // First update - all fees should be zero
    let res_0 = await ths.updateExchangeRateAndWait(
      program,
      client,
      context,
      new anchor.BN(0),
      new anchor.BN(1000000000),
      strategist,
      boringVaultStateAccount,
      boringVaultShareMint,
      deployer,
      86400
    );

    expect(res_0.feesOwed).to.equal(BigInt(0));
    expect(res_0.platformFees).to.equal(BigInt(0));
    expect(res_0.performanceFees).to.equal(BigInt(0));

    // Second update - all fees should be non-zero
    let res_1 = await ths.updateExchangeRateAndWait(
      program,
      client,
      context,
      new anchor.BN(0),
      new anchor.BN(1000500000),
      strategist,
      boringVaultStateAccount,
      boringVaultShareMint,
      deployer,
      86400
    );

    expect(res_1.feesOwed > BigInt(0));
    expect(res_1.platformFees > BigInt(0));
    expect(res_1.performanceFees > BigInt(0));
    // Verify fees owed equals sum of platform and performance fees
    expect(res_1.feesOwed - res_0.feesOwed).to.equal(
      res_1.platformFees + res_1.performanceFees
    );

    // Third update - only platform fees should increase
    let res_2 = await ths.updateExchangeRateAndWait(
      program,
      client,
      context,
      new anchor.BN(0),
      new anchor.BN(1000300000),
      strategist,
      boringVaultStateAccount,
      boringVaultShareMint,
      deployer,
      86400
    );

    expect(res_2.feesOwed > res_1.feesOwed);
    expect(res_2.platformFees > BigInt(0));
    expect(res_2.performanceFees).to.equal(BigInt(0));
    // Verify fees owed increased only by platform fees
    expect(res_2.feesOwed - res_1.feesOwed).to.equal(res_2.platformFees);

    // Fourth update - only platform fees should increase
    let res_3 = await ths.updateExchangeRateAndWait(
      program,
      client,
      context,
      new anchor.BN(0),
      new anchor.BN(1000400000),
      strategist,
      boringVaultStateAccount,
      boringVaultShareMint,
      deployer,
      86400
    );

    expect(res_3.feesOwed > res_2.feesOwed);
    expect(res_3.platformFees > BigInt(0));
    expect(res_3.performanceFees).to.equal(BigInt(0));
    // Verify fees owed increased only by platform fees
    expect(res_3.feesOwed - res_2.feesOwed).to.equal(res_3.platformFees);

    // Fifth update - both platform and performance fees should increase
    let res_4 = await ths.updateExchangeRateAndWait(
      program,
      client,
      context,
      new anchor.BN(0),
      new anchor.BN(1000700000),
      strategist,
      boringVaultStateAccount,
      boringVaultShareMint,
      deployer,
      86400
    );

    expect(res_4.feesOwed > res_3.feesOwed);
    expect(res_4.platformFees > BigInt(0));
    expect(res_4.performanceFees > BigInt(0));
    // Verify fees owed equals sum of platform and performance fees
    expect(res_4.feesOwed - res_3.feesOwed).to.equal(
      res_4.platformFees + res_4.performanceFees
    );

    // Sixth update - change exchange rate to a ridiculous value
    let res_5 = await ths.updateExchangeRateAndWait(
      program,
      client,
      context,
      new anchor.BN(0),
      new anchor.BN(2000000000),
      strategist,
      boringVaultStateAccount,
      boringVaultShareMint,
      deployer,
      86400
    );

    expect(res_5.feesOwed == res_4.feesOwed); // No fees should be owed since the exchange rate is too high, and we paused
    expect(res_5.platformFees == BigInt(0));
    expect(res_5.performanceFees == BigInt(0));

    let boringVaultState = await program.account.boringVault.fetch(
      boringVaultStateAccount
    );
    expect(boringVaultState.config.paused).to.be.true;

    // Unpause the vault
    const unpause_ix = await program.methods
      .unpause(new anchor.BN(0))
      .accounts({
        signer: authority.publicKey,
        boringVaultState: boringVaultStateAccount,
      })
      .instruction();

    let txResult_unpause = await ths.createAndProcessTransaction(
      client,
      deployer,
      unpause_ix,
      [authority]
    );
    ths.expectTxToSucceed(txResult_unpause.result);

    boringVaultState = await program.account.boringVault.fetch(
      boringVaultStateAccount
    );
    expect(boringVaultState.config.paused).to.be.false;

    // Seventh update - change exchange rate to a ridiculous low value
    let res_6 = await ths.updateExchangeRateAndWait(
      program,
      client,
      context,
      new anchor.BN(0),
      new anchor.BN(100000000),
      strategist,
      boringVaultStateAccount,
      boringVaultShareMint,
      deployer,
      86400
    );

    expect(res_6.feesOwed == res_5.feesOwed); // No fees should be owed since the exchange rate is too high, and we paused
    expect(res_6.platformFees == BigInt(0));
    expect(res_6.performanceFees == BigInt(0));

    boringVaultState = await program.account.boringVault.fetch(
      boringVaultStateAccount
    );
    expect(boringVaultState.config.paused).to.be.true;

    // Unpause the vault
    const unpause_ix_1 = await program.methods
      .unpause(new anchor.BN(0))
      .accounts({
        signer: authority.publicKey,
        boringVaultState: boringVaultStateAccount,
      })
      .instruction();

    let txResult_unpause_1 = await ths.createAndProcessTransaction(
      client,
      deployer,
      unpause_ix_1,
      [authority]
    );
    ths.expectTxToSucceed(txResult_unpause_1.result);

    // 8th update - change exchange rate to a ridiculous low value
    await ths.updateExchangeRateAndWait(
      program,
      client,
      context,
      new anchor.BN(0),
      new anchor.BN(1000000000),
      strategist,
      boringVaultStateAccount,
      boringVaultShareMint,
      deployer,
      86400
    );

    // Unpause the vault
    const unpause_ix_2 = await program.methods
      .unpause(new anchor.BN(0))
      .accounts({
        signer: authority.publicKey,
        boringVaultState: boringVaultStateAccount,
      })
      .instruction();

    let txResult_unpause_2 = await ths.createAndProcessTransaction(
      client,
      deployer,
      unpause_ix_2,
      [authority]
    );
    ths.expectTxToSucceed(txResult_unpause_2.result);
  });

  it("Can claim fees", async () => {
    let claim_fees_ix = await program.methods
      .claimFeesInBase(new anchor.BN(0), 0)
      .accounts({
        signer: authority.publicKey,
        baseMint: JITOSOL,
        boringVaultState: boringVaultStateAccount,
        boringVault: boringVaultAccount,
        payoutAta: payoutJitoSolAta,
        vaultAta: vaultJitoSolAta,
        // @ts-ignore
        tokenProgram: TOKEN_PROGRAM_ID,
        tokenProgram2022: TOKEN_2022_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .instruction();

    const vaultState = await program.account.boringVault.fetch(
      boringVaultStateAccount
    );
    let expectedFees = vaultState.teller.feesOwedInBaseAsset;

    let payoutJitoSolStartBalance = await ths.getTokenBalance(
      client,
      payoutJitoSolAta
    );

    let txResult = await ths.createAndProcessTransaction(
      client,
      authority,
      claim_fees_ix,
      [authority]
    );
    ths.expectTxToSucceed(txResult.result);

    let payoutJitoSolEndBalance = await ths.getTokenBalance(
      client,
      payoutJitoSolAta
    );

    const vaultStateAfter = await program.account.boringVault.fetch(
      boringVaultStateAccount
    );
    expect(vaultStateAfter.teller.feesOwedInBaseAsset.toString()).to.equal("0"); // Fees should have been zeroed

    expect(
      (payoutJitoSolEndBalance - payoutJitoSolStartBalance).toString()
    ).to.equal(expectedFees.toString()); // Fee should be transferred to payout
  });

  it("Can update and close cpi digests", async () => {
    // 1. View CPI Digest
    const digest = await program.methods
      .viewCpiDigest(
        // @ts-ignore
        {
          vaultId: new anchor.BN(0),
          ixProgramId: KAMINO_LEND_PROGRAM_ID,
          ixData: Buffer.from([]),
          operators: [],
          expectedSize: 32,
        }
      )
      .signers([deployer])
      .view();

    // 2. Find CPI Digest Account
    const [cpiDigestAccount] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("cpi-digest"),
        boringVaultStateAccount.toBuffer(),
        Buffer.from(digest),
      ],
      program.programId
    );

    // 3. Update CPI Digest
    const updateIx = await program.methods
      .updateCpiDigest({
        vaultId: new anchor.BN(0),
        cpiDigest: digest,
        isValid: true,
      })
      .accounts({
        signer: authority.publicKey,
        boringVaultState: boringVaultStateAccount,
        // @ts-ignore
        systemProgram: anchor.web3.SystemProgram.programId,
        cpiDigest: cpiDigestAccount,
      })
      .instruction();

    const updateTxResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      updateIx,
      [authority]
    );

    ths.expectTxToSucceed(updateTxResult.result);

    // 4. Close CPI Digest
    const closeIx = await program.methods
      .updateCpiDigest({
        vaultId: new anchor.BN(0),
        cpiDigest: digest,
        isValid: true,
      })
      .accounts({
        signer: authority.publicKey,
        boringVaultState: boringVaultStateAccount,
        // @ts-ignore
        cpiDigest: cpiDigestAccount,
      })
      .instruction();

    const closeIxResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      closeIx,
      [authority]
    );

    ths.expectTxToSucceed(closeIxResult.result);
  });

  it("Vault can deposit SOL into JitoSOL stake pool", async () => {
    // Transfer SOL from user to vault.
    const transferSolIx = anchor.web3.SystemProgram.transfer({
      fromPubkey: user.publicKey,
      toPubkey: boringVaultAccount,
      lamports: 10_000_000_000, // 10 SOL in lamports
    });

    let transferTxResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      transferSolIx,
      [user] // user needs to sign since they're sending the SOL
    );

    // Expect the transfer to succeed
    ths.expectTxToSucceed(transferTxResult.result);

    const remainingAccounts = CpiService.getJitoSolDepositAccounts({
      stakePool: JITO_SOL_STAKE_POOL,
      withdrawAuth: JITO_SOL_STAKE_POOL_WITHDRAW_AUTH,
      reserve: JITO_SOL_STAKE_POOL_RESERVE,
      vault: boringVaultAccount,
      vaultAta: vaultJitoSolAta,
      fee: JITO_SOL_STAKE_POOL_FEE,
      jitoSol: JITOSOL,
      systemProgram: anchor.web3.SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      stakePoolProgram: STAKE_POOL_PROGRAM_ID,
    });

    let txResult_0 = await CpiService.executeCpi(
      {
        program: program,
        client: client,
        deployer: deployer,
        authority: authority,
        strategist: strategist,
        vaultId: new anchor.BN(0),
        ixProgramId: STAKE_POOL_PROGRAM_ID,
        ixData: Buffer.from("0e40420f0000000000", "hex"),
        // @ts-ignore
        operators: CpiService.getJitoSolDepositOperators(),
        expectedSize: 399,
        accounts: {
          boringVaultState: boringVaultStateAccount,
          boringVault: boringVaultAccount,
        },
      },
      remainingAccounts
    );

    ths.expectTxToSucceed(txResult_0.result);
  });

  it("Can transfer sol and wrap it", async () => {
    // Create the transfer instruction data
    const transferIxData = Buffer.from("02000000f01d1f0000000000", "hex");

    // Get the accounts needed for transfer
    const transferAccounts = [
      { pubkey: boringVaultAccount, isWritable: true, isSigner: false }, // from
      { pubkey: vaultWSolAta, isWritable: true, isSigner: false }, // to
      {
        pubkey: anchor.web3.SystemProgram.programId,
        isWritable: false,
        isSigner: false,
      }, // system program
    ];

    const txResult_0 = await CpiService.executeCpi(
      {
        program: program,
        client: client,
        deployer: deployer,
        authority: authority,
        strategist: strategist,
        vaultId: new anchor.BN(0),
        ixProgramId: anchor.web3.SystemProgram.programId,
        ixData: transferIxData,
        // @ts-ignore
        operators: CpiService.getWSolTransferOperators(),
        expectedSize: 104,
        accounts: {
          boringVaultState: boringVaultStateAccount,
          boringVault: boringVaultAccount,
        },
      },
      transferAccounts
    );

    ths.expectTxToSucceed(txResult_0.result);

    // Now that our wSOL ata has SOL, we can wrap it.
    // Create the transfer instruction data
    const wrapIxData = Buffer.from([17]); // 11 in hex

    // Get the accounts needed for transfer
    const wrapAccounts = [
      { pubkey: vaultWSolAta, isWritable: true, isSigner: false }, // vault wSOL ATA
      { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false }, // token program
    ];

    let vaultWSolStartBalance = await ths.getTokenBalance(client, vaultWSolAta);

    const txResult_1 = await CpiService.executeCpi(
      {
        program: program,
        client: client,
        deployer: deployer,
        authority: authority,
        strategist: strategist,
        vaultId: new anchor.BN(0),
        ixProgramId: TOKEN_PROGRAM_ID,
        ixData: wrapIxData,
        // @ts-ignore
        operators: CpiService.getWSolWrapOperators(),
        expectedSize: 75,
        accounts: {
          boringVaultState: boringVaultStateAccount,
          boringVault: boringVaultAccount,
        },
      },
      wrapAccounts
    );

    ths.expectTxToSucceed(txResult_1.result);

    let vaultWSolEndBalance = await ths.getTokenBalance(client, vaultWSolAta);
    expect((vaultWSolEndBalance - vaultWSolStartBalance).toString()).to.equal(
      "2039280"
    );
  });

  it("I Can lend JitoSOL on Mock Kamino", async () => {
    // Create lookup table for user
    const [lookupTableInst, lookupTableAddress] =
      AddressLookupTableProgram.createLookupTable({
        authority: user.publicKey,
        payer: user.publicKey,
        recentSlot: 0, // Bankrun starts at slot 1, so use slot 0.
      });

    const targetProgramId = mockKaminoLendProgram.programId;

    const [userMetadataPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("user_meta"), // from https://github.com/Kamino-Finance/klend/blob/master/programs/klend/src/utils/seeds.rs#L7
        user.publicKey.toBuffer(),
      ],
      targetProgramId
    );

    // let initUserMetadataIx = await mockKaminoLendProgram.methods.initUserMetadata(lookupTableAddress).accounts({
    //   owner: user.publicKey,
    //   feePayer: user.publicKey,
    //   // @ts-ignore
    //   userMetadata: userMetadataPda,
    //   referrerUserMetadata: targetProgramId,
    //   rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    //   systemProgram: anchor.web3.SystemProgram.programId,
    // }).instruction();

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
    const [latestBlockhash] = await client.getLatestBlockhash();
    tx.recentBlockhash = latestBlockhash;
    tx.feePayer = user.publicKey;
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({
        units: 1_400_000,
      })
    );
    tx.add(lookupTableInst);
    tx.add(initUserMetadataIx);
    tx.sign(user);
    let result = await client.tryProcessTransaction(tx);
    ths.expectTxToSucceed(result.result);
  });

  it("I Can lend JitoSOL on Real Kamino", async () => {
    // Create lookup table for user
    const [lookupTableInst, lookupTableAddress] =
      AddressLookupTableProgram.createLookupTable({
        authority: user.publicKey,
        payer: user.publicKey,
        recentSlot: 0, // Bankrun starts at slot 1, so use slot 0.
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

    // Use dev test tx LUT to make sure this method of creating instruciton data is valid
    // Which it is the outputted instruction data in hex and bs58 are the same as the test tx.
    const testInitUserMetadataData = Buffer.concat([
      discriminator,
      new anchor.web3.PublicKey(
        "8xzmgxayzKLzEVQYti1rZpE5Bwad9dURmtGytfhbzkEe"
      ).toBuffer(),
    ]);
    const encoded = bs58.encode(testInitUserMetadataData);
    console.log("Instruction data: ", testInitUserMetadataData.toString("hex"));
    console.log("Encoded Data:", encoded);

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
    const [latestBlockhash] = await client.getLatestBlockhash();
    tx.recentBlockhash = latestBlockhash;
    tx.feePayer = user.publicKey;
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({
        units: 1_400_000,
      })
    );
    tx.add(lookupTableInst);
    tx.add(initUserMetadataIx);
    tx.sign(user);
    let result = await client.tryProcessTransaction(tx);
    ths.expectTxToSucceed(result.result);
  });

  it("Can lend JitoSOL on Kamino", async () => {
    // Example tx https://solscan.io/tx/2cUbGCXmzvtXfZmc1WYbypx4rJAamHcTLqJyswjnyFbHsmT3ToVDXxUVrcnCTYbH3HqWTWMhiJcJqbGaaG9nRzdA

    // Step 0: Call Create Lookup Table
    const [lookupTableInst, lookupTableAddress] =
      AddressLookupTableProgram.createLookupTable({
        authority: boringVaultAccount,
        payer: boringVaultAccount,
        recentSlot: 0, // Bankrun starts at slot 1, so use slot 0.
      });

    const createLookupTableAccounts = [
      { pubkey: lookupTableAddress, isWritable: true, isSigner: false },
      { pubkey: boringVaultAccount, isWritable: true, isSigner: false },
      { pubkey: boringVaultAccount, isWritable: true, isSigner: false },
      {
        pubkey: anchor.web3.SystemProgram.programId,
        isWritable: false,
        isSigner: false,
      },
      { pubkey: lookupTableInst.programId, isWritable: false, isSigner: false },
    ];

    let txResult_0 = await CpiService.executeCpi(
      {
        program: program,
        client: client,
        deployer: deployer,
        authority: authority,
        strategist: strategist,
        vaultId: new anchor.BN(0),
        ixProgramId: lookupTableInst.programId,
        ixData: lookupTableInst.data,
        // @ts-ignore
        operators: CpiService.getCreateLookupTableOperators(),
        expectedSize: 32,
        accounts: {
          boringVaultState: boringVaultStateAccount,
          boringVault: boringVaultAccount,
        },
      },
      createLookupTableAccounts
    );

    ths.expectTxToSucceed(txResult_0.result);

    // Step 1: Call Init User Metadata on Kamino Lend Program.
    const targetProgramId = mockKaminoLendProgram.programId;

    // Advance to slot 2 to ensure the lookup table is warm.
    context.warpToSlot(BigInt(2));

    const [userMetadataPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("user_meta"), // from https://github.com/Kamino-Finance/klend/blob/master/programs/klend/src/utils/seeds.rs#L7
        boringVaultAccount.toBuffer(),
      ],
      targetProgramId
    );

    const discriminator = Buffer.from("75a9b045c5170fa2", "hex");
    const initUserMetadataIx = Buffer.concat([
      discriminator,
      lookupTableAddress.toBuffer(),
    ]);

    const initUserMetadataAccounts = [
      { pubkey: boringVaultAccount, isWritable: true, isSigner: false },
      { pubkey: boringVaultAccount, isWritable: true, isSigner: false },
      { pubkey: userMetadataPda, isWritable: true, isSigner: false },
      { pubkey: targetProgramId, isWritable: false, isSigner: false },
      {
        pubkey: anchor.web3.SYSVAR_RENT_PUBKEY,
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: anchor.web3.SystemProgram.programId,
        isSigner: false,
        isWritable: false,
      },
    ];

    let txResult_1 = await CpiService.executeCpi(
      {
        program: program,
        client: client,
        deployer: deployer,
        authority: authority,
        strategist: strategist,
        vaultId: new anchor.BN(0),
        ixProgramId: targetProgramId,
        ixData: initUserMetadataIx,
        // @ts-ignore
        operators: CpiService.getInitUserMetadataOperators(),
        expectedSize: 32,
        accounts: {
          boringVaultState: boringVaultStateAccount,
          boringVault: boringVaultAccount,
        },
      },
      initUserMetadataAccounts
    );
    ths.expectTxToSucceed(txResult_1.result);

    // Step 2: Call Init Obligation on Kamino Lend Program.
    // const initObligationAccounts = [
    //   { pubkey: boringVaultAccount, isWritable: true, isSigner: false },
    //   { pubkey: boringVaultAccount, isWritable: true, isSigner: false },
    //   { pubkey: anchor.web3.SystemProgram.programId, isWritable: false, isSigner: false },
    //   { pubkey: KAMINO_LEND_PROGRAM_ID, isWritable: false, isSigner: false },
    // ];
  });

  it("Queue is initialized", async () => {
    const ix = await queueProgram.methods
      .initialize(deployer.publicKey)
      .accounts({
        signer: deployer.publicKey,
        // @ts-ignore
        config: queueProgramConfigAccount,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .instruction();

    let txResult = await ths.createAndProcessTransaction(client, deployer, ix, [
      deployer,
    ]);
    ths.expectTxToSucceed(txResult.result);

    const queueConfig = await queueProgram.account.programConfig.fetch(
      queueProgramConfigAccount
    );
    expect(queueConfig.authority.equals(deployer.publicKey)).to.be.true;
  });

  it("Can deploy a queue", async () => {
    const ix = await queueProgram.methods
      .deploy({
        authority: authority.publicKey,
        boringVaultProgram: program.programId,
        vaultId: new anchor.BN(0),
        shareMint: boringVaultShareMint,
        solveAuthority: anchor.web3.SystemProgram.programId,
      })
      .accounts({
        signer: deployer.publicKey,
        // @ts-ignore
        config: queueProgramConfigAccount,
        queueState: queueStateAccount,
        queue: queueAccount,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .instruction();

    let txResult = await ths.createAndProcessTransaction(client, deployer, ix, [
      deployer,
    ]);
    ths.expectTxToSucceed(txResult.result);

    const queueState = await queueProgram.account.queueState.fetch(
      queueStateAccount
    );
    expect(queueState.authority.equals(authority.publicKey)).to.be.true;
    expect(queueState.boringVaultProgram.equals(program.programId)).to.be.true;
    expect(queueState.vaultId.toNumber()).to.equal(0);
    expect(queueState.paused).to.be.false;
  });

  // ... existing tests ...

  it("Can set solve authority", async () => {
    // Store original solve authority
    const queueState = await queueProgram.account.queueState.fetch(
      queueStateAccount
    );
    const originalSolveAuthority = queueState.solveAuthority;

    // Set new solve authority
    const newSolveAuthority = anchor.web3.Keypair.generate().publicKey;
    const ix = await queueProgram.methods
      .setSolveAuthority(new anchor.BN(0), newSolveAuthority)
      .accounts({
        signer: authority.publicKey,
        queueState: queueStateAccount,
      })
      .instruction();

    let txResult = await ths.createAndProcessTransaction(client, deployer, ix, [
      authority,
    ]);
    ths.expectTxToSucceed(txResult.result);

    // Verify solve authority was changed
    const updatedState = await queueProgram.account.queueState.fetch(
      queueStateAccount
    );
    expect(updatedState.solveAuthority.equals(newSolveAuthority)).to.be.true;

    // Revert back to original
    const revertIx = await queueProgram.methods
      .setSolveAuthority(new anchor.BN(0), originalSolveAuthority)
      .accounts({
        signer: authority.publicKey,
        queueState: queueStateAccount,
      })
      .instruction();

    let revertTxResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      revertIx,
      [authority]
    );
    ths.expectTxToSucceed(revertTxResult.result);

    // Verify reverted back
    const finalState = await queueProgram.account.queueState.fetch(
      queueStateAccount
    );
    expect(finalState.solveAuthority.equals(originalSolveAuthority)).to.be.true;
  });

  it("Can pause and unpause queue", async () => {
    // Store original pause state
    const queueState = await queueProgram.account.queueState.fetch(
      queueStateAccount
    );
    const originalPauseState = queueState.paused;

    // Pause queue
    const pauseIx = await queueProgram.methods
      .pause(new anchor.BN(0))
      .accounts({
        signer: authority.publicKey,
        queueState: queueStateAccount,
      })
      .instruction();

    let pauseTxResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      pauseIx,
      [authority]
    );
    ths.expectTxToSucceed(pauseTxResult.result);

    // Verify queue is paused
    const pausedState = await queueProgram.account.queueState.fetch(
      queueStateAccount
    );
    expect(pausedState.paused).to.be.true;

    // Unpause queue
    const unpauseIx = await queueProgram.methods
      .unpause(new anchor.BN(0))
      .accounts({
        signer: authority.publicKey,
        queueState: queueStateAccount,
      })
      .instruction();

    let unpauseTxResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      unpauseIx,
      [authority]
    );
    ths.expectTxToSucceed(unpauseTxResult.result);

    // Verify queue is unpaused
    const unpausedState = await queueProgram.account.queueState.fetch(
      queueStateAccount
    );
    expect(unpausedState.paused).to.be.false;

    // If original state was paused, pause it again to restore original state
    if (originalPauseState) {
      const restoreIx = await queueProgram.methods
        .pause(new anchor.BN(0))
        .accounts({
          signer: authority.publicKey,
          queueState: queueStateAccount,
        })
        .instruction();

      let restoreTxResult = await ths.createAndProcessTransaction(
        client,
        deployer,
        restoreIx,
        [authority]
      );
      ths.expectTxToSucceed(restoreTxResult.result);
    }

    // Verify final state matches original
    const finalState = await queueProgram.account.queueState.fetch(
      queueStateAccount
    );
    expect(finalState.paused).to.equal(originalPauseState);
  });

  it("Cannot set solve authority without authority", async () => {
    // Try to set new solve authority with wrong signer
    const newSolveAuthority = anchor.web3.Keypair.generate().publicKey;
    const ix = await queueProgram.methods
      .setSolveAuthority(new anchor.BN(0), newSolveAuthority)
      .accounts({
        signer: user.publicKey,
        queueState: queueStateAccount,
      })
      .instruction();

    let txResult = await ths.createAndProcessTransaction(client, deployer, ix, [
      user,
    ]);
    ths.expectTxToFail(
      txResult.result,
      txResult.meta.logMessages,
      "Not authorized"
    );
  });

  it("Cannot pause/unpause queue without authority", async () => {
    // Try to pause with wrong signer
    const pauseIx = await queueProgram.methods
      .pause(new anchor.BN(0))
      .accounts({
        signer: user.publicKey,
        queueState: queueStateAccount,
      })
      .instruction();

    let pauseTxResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      pauseIx,
      [user]
    );
    ths.expectTxToFail(
      pauseTxResult.result,
      pauseTxResult.meta.logMessages,
      "Not authorized"
    ); // Should fail

    // Try to unpause with wrong signer
    const unpauseIx = await queueProgram.methods
      .unpause(new anchor.BN(0))
      .accounts({
        signer: user.publicKey,
        queueState: queueStateAccount,
      })
      .instruction();

    let unpauseTxResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      unpauseIx,
      [user]
    );
    ths.expectTxToFail(
      unpauseTxResult.result,
      unpauseTxResult.meta.logMessages,
      "Not authorized"
    ); // Should fail
  });

  it("Can update withdraw assets", async () => {
    // Initial update
    const initialState = {
      vaultId: new anchor.BN(0),
      allowWithdraws: true,
      secondsToMaturity: 86400,
      minimumSecondsToDeadline: 2 * 86400,
      minimumDiscount: 1,
      maximumDiscount: 10,
      minimumShares: new anchor.BN(1000),
    };

    const ix = await queueProgram.methods
      .updateWithdrawAssetData(initialState)
      .accounts({
        signer: authority.publicKey,
        queueState: queueStateAccount,
        withdrawMint: JITOSOL,
        withdrawAssetData: jitoSolWithdrawAssetData,
      })
      .instruction();

    let txResult = await ths.createAndProcessTransaction(client, deployer, ix, [
      authority,
    ]);
    ths.expectTxToSucceed(txResult.result);

    // Verify initial state
    let withdrawAssetData = await queueProgram.account.withdrawAssetData.fetch(
      jitoSolWithdrawAssetData
    );
    expect(withdrawAssetData.allowWithdrawals).to.be.true;
    expect(withdrawAssetData.secondsToMaturity).to.equal(86400);
    expect(withdrawAssetData.minimumSecondsToDeadline).to.equal(2 * 86400);
    expect(withdrawAssetData.minimumDiscount).to.equal(1);
    expect(withdrawAssetData.maximumDiscount).to.equal(10);
    expect(withdrawAssetData.minimumShares.toNumber()).to.equal(1000);

    // Update to disable withdrawals
    const disabledState = {
      ...initialState,
      allowWithdraws: false,
    };

    const disableIx = await queueProgram.methods
      .updateWithdrawAssetData(disabledState)
      .accounts({
        signer: authority.publicKey,
        queueState: queueStateAccount,
        withdrawMint: JITOSOL,
        withdrawAssetData: jitoSolWithdrawAssetData,
      })
      .instruction();

    txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      disableIx,
      [authority]
    );
    ths.expectTxToSucceed(txResult.result);

    // Verify withdrawals are disabled
    withdrawAssetData = await queueProgram.account.withdrawAssetData.fetch(
      jitoSolWithdrawAssetData
    );
    expect(withdrawAssetData.allowWithdrawals).to.be.false;
    // Verify other fields remained unchanged
    expect(withdrawAssetData.secondsToMaturity).to.equal(86400);
    expect(withdrawAssetData.minimumSecondsToDeadline).to.equal(2 * 86400);
    expect(withdrawAssetData.minimumDiscount).to.equal(1);
    expect(withdrawAssetData.maximumDiscount).to.equal(10);
    expect(withdrawAssetData.minimumShares.toNumber()).to.equal(1000);

    // Revert back to initial state
    const revertIx = await queueProgram.methods
      .updateWithdrawAssetData(initialState)
      .accounts({
        signer: authority.publicKey,
        queueState: queueStateAccount,
        withdrawMint: JITOSOL,
        withdrawAssetData: jitoSolWithdrawAssetData,
      })
      .instruction();

    txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      revertIx,
      [authority]
    );
    ths.expectTxToSucceed(txResult.result);

    // Verify state is back to initial
    withdrawAssetData = await queueProgram.account.withdrawAssetData.fetch(
      jitoSolWithdrawAssetData
    );
    expect(withdrawAssetData.allowWithdrawals).to.be.true;
    expect(withdrawAssetData.secondsToMaturity).to.equal(86400);
    expect(withdrawAssetData.minimumSecondsToDeadline).to.equal(2 * 86400);
    expect(withdrawAssetData.minimumDiscount).to.equal(1);
    expect(withdrawAssetData.maximumDiscount).to.equal(10);
    expect(withdrawAssetData.minimumShares.toNumber()).to.equal(1000);
  });

  it("Allows users to setup withdraw state", async () => {
    const ix = await queueProgram.methods
      .setupUserWithdrawState()
      .accounts({
        signer: user.publicKey,
        // @ts-ignore
        userWithdrawState: userWithdrawState,
      })
      .instruction();

    let txResult = await ths.createAndProcessTransaction(client, deployer, ix, [
      user,
    ]);
    ths.expectTxToSucceed(txResult.result);
  });

  it("Allows users to make withdraw requests", async () => {
    let bump;
    [userWithdrawRequest, bump] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("boring-queue-withdraw-request"),
        user.publicKey.toBuffer(),
        Buffer.from(new Array(8).fill(0)),
      ],
      queueProgram.programId
    );

    const ix_withdraw_request = await queueProgram.methods
      .requestWithdraw({
        vaultId: new anchor.BN(0),
        shareAmount: new anchor.BN(1000000),
        discount: 3,
        secondsToDeadline: 3 * 86400,
      })
      .accounts({
        signer: user.publicKey,
        queueState: queueStateAccount,
        withdrawMint: JITOSOL,
        withdrawAssetData: jitoSolWithdrawAssetData,
        // @ts-ignore
        userWithdrawState: userWithdrawState,
        withdrawRequest: userWithdrawRequest,
        queue: queueAccount,
        shareMint: boringVaultShareMint,
        // @ts-ignore
        userShares: userShareAta,
        queueShares: queueShareAta,
        tokenProgram2022: TOKEN_2022_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
        boringVaultProgram: program.programId,
        boringVaultState: boringVaultStateAccount,
        vaultAssetData: jitoSolAssetDataPda,
        priceFeed: anchor.web3.PublicKey.default,
      })
      .instruction();

    let txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      ix_withdraw_request,
      [user]
    );
    ths.expectTxToSucceed(txResult.result);
  });

  it("Allows requests to be solved", async () => {
    await ths.wait(client, context, 86_401);

    const solve_ix = await queueProgram.methods
      .fulfillWithdraw(
        new anchor.BN(0) // request id 0
      )
      .accounts({
        solver: user.publicKey,
        user: user.publicKey,
        queueState: queueStateAccount,
        withdrawMint: JITOSOL,
        userAta: userJitoSolAta,
        queueAta: queueJitoSolAta,
        vaultAta: vaultJitoSolAta,
        withdrawRequest: userWithdrawRequest,
        queue: queueAccount,
        shareMint: boringVaultShareMint,
        // @ts-ignore
        queueShares: queueShareAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        tokenProgram2022: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
        boringVaultProgram: program.programId,
        boringVaultState: boringVaultStateAccount,
        boringVault: boringVaultAccount,
        vaultAssetData: jitoSolAssetDataPda,
        priceFeed: anchor.web3.PublicKey.default,
      })
      .instruction();

    let userJitoSolStartBalance = await ths.getTokenBalance(
      client,
      userJitoSolAta
    );
    let vaultJitoSolStartBalance = await ths.getTokenBalance(
      client,
      vaultJitoSolAta
    );
    let queueJitoSolStartBalance = await ths.getTokenBalance(
      client,
      queueJitoSolAta
    );

    let txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      solve_ix,
      [user]
    );
    ths.expectTxToSucceed(txResult.result);

    let userJitoSolEndBalance = await ths.getTokenBalance(
      client,
      userJitoSolAta
    );
    let vaultJitoSolEndBalance = await ths.getTokenBalance(
      client,
      vaultJitoSolAta
    );
    let queueJitoSolEndBalance = await ths.getTokenBalance(
      client,
      queueJitoSolAta
    );

    expect(
      (userJitoSolEndBalance - userJitoSolStartBalance).toString()
    ).to.equal("999700"); // User gained JitoSol
    expect(
      (vaultJitoSolStartBalance - vaultJitoSolEndBalance).toString()
    ).to.equal("999700"); // Vault lossed JitoSol
    expect(
      (queueJitoSolStartBalance - queueJitoSolEndBalance).toString()
    ).to.equal("0"); // Queue had no change
  });

  it("Allows users to cancel withdraw requests only after deadline", async () => {
    let bump;
    [userWithdrawRequest, bump] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("boring-queue-withdraw-request"),
        user.publicKey.toBuffer(),
        Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]),
      ],
      queueProgram.programId
    );

    // Create withdraw request
    const ix_withdraw_request = await queueProgram.methods
      .requestWithdraw(
        // @ts-ignore
        {
          vaultId: new anchor.BN(0),
          shareAmount: new anchor.BN(1000000),
          discount: new anchor.BN(3),
          secondsToDeadline: new anchor.BN(3 * 86400), // 3 days deadline
        }
      )
      .accounts({
        signer: user.publicKey,
        queueState: queueStateAccount,
        withdrawMint: JITOSOL,
        withdrawAssetData: jitoSolWithdrawAssetData,
        // @ts-ignore
        userWithdrawState: userWithdrawState,
        withdrawRequest: userWithdrawRequest,
        queue: queueAccount,
        shareMint: boringVaultShareMint,
        // @ts-ignore
        userShares: userShareAta,
        queueShares: queueShareAta,
        tokenProgram2022: TOKEN_2022_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
        boringVaultProgram: program.programId,
        boringVaultState: boringVaultStateAccount,
        vaultAssetData: jitoSolAssetDataPda,
        priceFeed: anchor.web3.PublicKey.default,
      })
      .instruction();

    let txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      ix_withdraw_request,
      [user]
    );
    ths.expectTxToSucceed(txResult.result);

    // Try to cancel before deadline - should fail
    const cancel_ix = await queueProgram.methods
      .cancelWithdraw(new anchor.BN(1))
      .accounts({
        signer: user.publicKey,
        shareMint: boringVaultShareMint,
        queueState: queueStateAccount,
        withdrawRequest: userWithdrawRequest,
        queue: queueAccount,
        // @ts-ignore
        userShares: userShareAta,
        queueShares: queueShareAta,
        tokenProgram2022: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
      })
      .instruction();

    let earlyResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      cancel_ix,
      [user]
    );
    ths.expectTxToFail(
      earlyResult.result,
      earlyResult.meta.logMessages,
      "Request deadline not passed"
    ); // Should fail

    // Wait until after deadline (3 days maturity + 3 days deadline = 6 days)
    await ths.wait(client, context, 6 * 86400);

    // Now try to cancel after deadline
    let userShareStartBalance = await ths.getTokenBalance(client, userShareAta);

    let cancelResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      cancel_ix,
      [user]
    );
    ths.expectTxToSucceed(cancelResult.result);

    let userShareEndBalance = await ths.getTokenBalance(client, userShareAta);

    // Verify shares were returned
    expect((userShareEndBalance - userShareStartBalance).toString()).to.equal(
      "1000000"
    ); // User gained Shares

    // Verify withdraw request account was closed
    const withdrawRequestAccount = await client.getAccount(userWithdrawRequest);
    expect(withdrawRequestAccount).to.be.null;
  });

  it("Can pause and unpause vault", async () => {
    // Check initial state
    let vaultState = await program.account.boringVault.fetch(
      boringVaultStateAccount
    );
    expect(vaultState.config.paused).to.be.false;

    // Pause the vault
    const pauseIx = await program.methods
      .pause(new anchor.BN(0))
      .accounts({
        signer: authority.publicKey,
        boringVaultState: boringVaultStateAccount,
      })
      .instruction();

    let pauseTxResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      pauseIx,
      [authority]
    );

    // Check transaction succeeded
    ths.expectTxToSucceed(pauseTxResult.result);

    // Verify vault is paused
    vaultState = await program.account.boringVault.fetch(
      boringVaultStateAccount
    );
    expect(vaultState.config.paused).to.be.true;

    // Try to perform an action while paused (should fail)
    const updateRateIx = await program.methods
      .updateExchangeRate(new anchor.BN(0), new anchor.BN(1000000000))
      .accounts({
        signer: strategist.publicKey,
        boringVaultState: boringVaultStateAccount,
        // @ts-ignore
        shareMint: boringVaultShareMint,
        clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
      })
      .instruction();

    let txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      updateRateIx,
      [strategist]
    );
    ths.expectTxToFail(
      txResult.result,
      txResult.meta.logMessages,
      "Vault paused"
    ); // Transaction should fail

    // Unpause the vault
    const unpauseIx = await program.methods
      .unpause(new anchor.BN(0))
      .accounts({
        signer: authority.publicKey,
        boringVaultState: boringVaultStateAccount,
      })
      .instruction();

    let unpauseTxResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      unpauseIx,
      [authority]
    );

    // Check transaction succeeded or was already processed
    ths.expectTxToSucceed(unpauseTxResult.result);

    // Verify vault is unpaused
    vaultState = await program.account.boringVault.fetch(
      boringVaultStateAccount
    );
    expect(vaultState.config.paused).to.be.false;

    // Verify we can now perform actions
    const updateRateIx2 = await program.methods
      .updateExchangeRate(new anchor.BN(0), new anchor.BN(1000000000))
      .accounts({
        signer: strategist.publicKey,
        boringVaultState: boringVaultStateAccount,
        // @ts-ignore
        shareMint: boringVaultShareMint,
        clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
      })
      .instruction();

    let updateTxResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      updateRateIx2,
      [strategist]
    );
    ths.expectTxToSucceed(updateTxResult.result);
  });

  it("Can update exchange rate provider", async () => {
    // Store original provider
    const originalProvider = (
      await program.account.boringVault.fetch(boringVaultStateAccount)
    ).teller.exchangeRateProvider;

    // Create a new dummy provider
    const newProvider = anchor.web3.Keypair.generate().publicKey;

    // Update the provider
    const updateIx = await program.methods
      .updateExchangeRateProvider(new anchor.BN(0), newProvider)
      .accounts({
        signer: authority.publicKey,
        boringVaultState: boringVaultStateAccount,
      })
      .instruction();

    let txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      updateIx,
      [authority]
    );

    // Expect the tx to succeed
    ths.expectTxToSucceed(txResult.result);

    // Verify the provider was updated
    let vaultState = await program.account.boringVault.fetch(
      boringVaultStateAccount
    );
    expect(vaultState.teller.exchangeRateProvider.toString()).to.equal(
      newProvider.toString()
    );

    // Change it back to original
    const revertIx = await program.methods
      .updateExchangeRateProvider(new anchor.BN(0), originalProvider)
      .accounts({
        signer: authority.publicKey,
        boringVaultState: boringVaultStateAccount,
      })
      .instruction();

    let revertTxResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      revertIx,
      [authority]
    );

    // Expect the revert tx to succeed
    ths.expectTxToSucceed(revertTxResult.result);

    // Verify the provider was reverted
    vaultState = await program.account.boringVault.fetch(
      boringVaultStateAccount
    );
    expect(vaultState.teller.exchangeRateProvider.toString()).to.equal(
      originalProvider.toString()
    );
  });

  it("Can update withdraw authority", async () => {
    // Store original provider
    const originalAuthority = (
      await program.account.boringVault.fetch(boringVaultStateAccount)
    ).teller.withdrawAuthority;

    // Create a new dummy authority
    const newAuthority = anchor.web3.Keypair.generate().publicKey;

    // Update the authority
    const updateIx = await program.methods
      .setWithdrawAuthority(new anchor.BN(0), newAuthority)
      .accounts({
        signer: authority.publicKey,
        boringVaultState: boringVaultStateAccount,
      })
      .instruction();

    let txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      updateIx,
      [authority]
    );
    ths.expectTxToSucceed(txResult.result);

    // Verify the authority was updated
    let vaultState = await program.account.boringVault.fetch(
      boringVaultStateAccount
    );
    expect(vaultState.teller.withdrawAuthority.toString()).to.equal(
      newAuthority.toString()
    );

    // Change it back to original
    const revertIx = await program.methods
      .setWithdrawAuthority(new anchor.BN(0), originalAuthority)
      .accounts({
        signer: authority.publicKey,
        boringVaultState: boringVaultStateAccount,
      })
      .instruction();

    let revertTxResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      revertIx,
      [authority]
    );
    ths.expectTxToSucceed(revertTxResult.result);

    // Verify the authority was reverted
    vaultState = await program.account.boringVault.fetch(
      boringVaultStateAccount
    );
    expect(vaultState.teller.withdrawAuthority.toString()).to.equal(
      originalAuthority.toString()
    );
  });

  it("Can update deposit sub account", async () => {
    const originalSubAccount = (
      await program.account.boringVault.fetch(boringVaultStateAccount)
    ).config.depositSubAccount;
    const newSubAccount = 2;

    const updateIx = await program.methods
      .setDepositSubAccount(new anchor.BN(0), newSubAccount)
      .accounts({
        signer: authority.publicKey,
        boringVaultState: boringVaultStateAccount,
      })
      .instruction();

    let txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      updateIx,
      [authority]
    );
    ths.expectTxToSucceed(txResult.result);

    let vaultState = await program.account.boringVault.fetch(
      boringVaultStateAccount
    );
    expect(vaultState.config.depositSubAccount).to.equal(newSubAccount);

    // Revert
    const revertIx = await program.methods
      .setDepositSubAccount(new anchor.BN(0), originalSubAccount)
      .accounts({
        signer: authority.publicKey,
        boringVaultState: boringVaultStateAccount,
      })
      .instruction();

    let revertTxResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      revertIx,
      [authority]
    );
    ths.expectTxToSucceed(revertTxResult.result);
  });

  it("Can update withdraw sub account", async () => {
    const originalSubAccount = (
      await program.account.boringVault.fetch(boringVaultStateAccount)
    ).config.withdrawSubAccount;
    const newSubAccount = 3;

    const updateIx = await program.methods
      .setWithdrawSubAccount(new anchor.BN(0), newSubAccount)
      .accounts({
        signer: authority.publicKey,
        boringVaultState: boringVaultStateAccount,
      })
      .instruction();

    let txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      updateIx,
      [authority]
    );
    ths.expectTxToSucceed(txResult.result);

    let vaultState = await program.account.boringVault.fetch(
      boringVaultStateAccount
    );
    expect(vaultState.config.withdrawSubAccount).to.equal(newSubAccount);

    // Revert
    const revertIx = await program.methods
      .setWithdrawSubAccount(new anchor.BN(0), originalSubAccount)
      .accounts({
        signer: authority.publicKey,
        boringVaultState: boringVaultStateAccount,
      })
      .instruction();

    let revertTxResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      revertIx,
      [authority]
    );
    ths.expectTxToSucceed(revertTxResult.result);
  });

  it("Can update payout address", async () => {
    const originalPayout = (
      await program.account.boringVault.fetch(boringVaultStateAccount)
    ).teller.payoutAddress;
    const newPayout = anchor.web3.Keypair.generate().publicKey;

    const updateIx = await program.methods
      .setPayout(new anchor.BN(0), newPayout)
      .accounts({
        signer: authority.publicKey,
        boringVaultState: boringVaultStateAccount,
      })
      .instruction();

    let txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      updateIx,
      [authority]
    );
    ths.expectTxToSucceed(txResult.result);

    let vaultState = await program.account.boringVault.fetch(
      boringVaultStateAccount
    );
    expect(vaultState.teller.payoutAddress.toString()).to.equal(
      newPayout.toString()
    );

    // Revert
    const revertIx = await program.methods
      .setPayout(new anchor.BN(0), originalPayout)
      .accounts({
        signer: authority.publicKey,
        boringVaultState: boringVaultStateAccount,
      })
      .instruction();

    let revertTxResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      revertIx,
      [authority]
    );
    ths.expectTxToSucceed(revertTxResult.result);
  });

  it("Can configure exchange rate update bounds", async () => {
    const originalBounds = (
      await program.account.boringVault.fetch(boringVaultStateAccount)
    ).teller;
    const newBounds = {
      upperBound: 11000,
      lowerBound: 9000,
      minimumUpdateDelay: 3600,
    };

    const updateIx = await program.methods
      .configureExchangeRateUpdateBounds(new anchor.BN(0), newBounds)
      .accounts({
        signer: authority.publicKey,
        boringVaultState: boringVaultStateAccount,
      })
      .instruction();

    let txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      updateIx,
      [authority]
    );
    ths.expectTxToSucceed(txResult.result);

    let vaultState = await program.account.boringVault.fetch(
      boringVaultStateAccount
    );
    expect(vaultState.teller.allowedExchangeRateChangeUpperBound).to.equal(
      newBounds.upperBound
    );
    expect(vaultState.teller.allowedExchangeRateChangeLowerBound).to.equal(
      newBounds.lowerBound
    );
    expect(vaultState.teller.minimumUpdateDelayInSeconds).to.equal(
      newBounds.minimumUpdateDelay
    );

    // Revert
    const revertIx = await program.methods
      .configureExchangeRateUpdateBounds(new anchor.BN(0), {
        upperBound: originalBounds.allowedExchangeRateChangeUpperBound,
        lowerBound: originalBounds.allowedExchangeRateChangeLowerBound,
        minimumUpdateDelay: originalBounds.minimumUpdateDelayInSeconds,
      })
      .accounts({
        signer: authority.publicKey,
        boringVaultState: boringVaultStateAccount,
      })
      .instruction();

    let revertTxResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      revertIx,
      [authority]
    );
    ths.expectTxToSucceed(revertTxResult.result);
  });

  it("Can update fees", async () => {
    const originalFees = (
      await program.account.boringVault.fetch(boringVaultStateAccount)
    ).teller;
    const newPlatformFee = 50;
    const newPerformanceFee = 1000;

    const updateIx = await program.methods
      .setFees(new anchor.BN(0), newPlatformFee, newPerformanceFee)
      .accounts({
        signer: authority.publicKey,
        boringVaultState: boringVaultStateAccount,
      })
      .instruction();

    let txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      updateIx,
      [authority]
    );
    ths.expectTxToSucceed(txResult.result);

    let vaultState = await program.account.boringVault.fetch(
      boringVaultStateAccount
    );
    expect(vaultState.teller.platformFeeBps).to.equal(newPlatformFee);
    expect(vaultState.teller.performanceFeeBps).to.equal(newPerformanceFee);

    // Revert
    const revertIx = await program.methods
      .setFees(
        new anchor.BN(0),
        originalFees.platformFeeBps,
        originalFees.performanceFeeBps
      )
      .accounts({
        signer: authority.publicKey,
        boringVaultState: boringVaultStateAccount,
      })
      .instruction();

    let revertTxResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      revertIx,
      [authority]
    );
    ths.expectTxToSucceed(revertTxResult.result);
  });

  it("Can update strategist", async () => {
    const originalStrategist = (
      await program.account.boringVault.fetch(boringVaultStateAccount)
    ).manager.strategist;
    const newStrategist = anchor.web3.Keypair.generate().publicKey;

    const updateIx = await program.methods
      .setStrategist(new anchor.BN(0), newStrategist)
      .accounts({
        signer: authority.publicKey,
        boringVaultState: boringVaultStateAccount,
      })
      .instruction();

    let txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      updateIx,
      [authority]
    );
    ths.expectTxToSucceed(txResult.result);

    let vaultState = await program.account.boringVault.fetch(
      boringVaultStateAccount
    );
    expect(vaultState.manager.strategist.toString()).to.equal(
      newStrategist.toString()
    );

    // Revert
    const revertIx = await program.methods
      .setStrategist(new anchor.BN(0), originalStrategist)
      .accounts({
        signer: authority.publicKey,
        boringVaultState: boringVaultStateAccount,
      })
      .instruction();

    let revertTxResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      revertIx,
      [authority]
    );
    ths.expectTxToSucceed(revertTxResult.result);
  });

  it("Set fees - failure cases", async () => {
    // Try with non-authority signer
    const nonAuthUpdateIx = await program.methods
      .setFees(new anchor.BN(0), 50, 1000)
      .accounts({
        signer: user.publicKey, // Using non-authority signer
        boringVaultState: boringVaultStateAccount,
      })
      .instruction();

    let txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      nonAuthUpdateIx,
      [user]
    );
    ths.expectTxToFail(
      txResult.result,
      txResult.meta.logMessages,
      "NotAuthorized"
    );

    // Try with invalid platform fee (>10000 bps)
    const invalidPlatformFeeIx = await program.methods
      .setFees(new anchor.BN(0), 10001, 1000)
      .accounts({
        signer: authority.publicKey,
        boringVaultState: boringVaultStateAccount,
      })
      .instruction();

    txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      invalidPlatformFeeIx,
      [authority]
    );
    ths.expectTxToFail(
      txResult.result,
      txResult.meta.logMessages,
      "Invalid Platform Fee BPS"
    );

    // Try with invalid performance fee (>10000 bps)
    const invalidPerformanceFeeIx = await program.methods
      .setFees(new anchor.BN(0), 50, 10001)
      .accounts({
        signer: authority.publicKey,
        boringVaultState: boringVaultStateAccount,
      })
      .instruction();

    txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      invalidPerformanceFeeIx,
      [authority]
    );
    ths.expectTxToFail(
      txResult.result,
      txResult.meta.logMessages,
      "Invalid Performance Fee BPS"
    );
  });

  it("Initialize - failure cases", async () => {
    // Try to initialize again with same config account
    const [configAccount] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("boring-config")],
      program.programId
    );

    const initializeIx = await program.methods
      .initialize(authority.publicKey)
      .accounts({
        signer: authority.publicKey,
        // @ts-ignore
        config: configAccount,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .instruction();

    const txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      initializeIx,
      [authority]
    );

    // Should fail with a raw anchor error (no custom error message)
    expect(txResult.result).to.not.be.null;
  });

  it("Deploy - failure cases", async () => {
    const [newVaultState] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("boring-vault-state"),
        new anchor.BN(1).toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    const [newVaultShareMint] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("share-token"), newVaultState.toBuffer()],
      program.programId
    );

    const deployArgs = {
      authority: user.publicKey,
      name: "Test Vault",
      symbol: "tVAULT",
      exchangeRateProvider: authority.publicKey,
      exchangeRate: new anchor.BN(1_000_000),
      payoutAddress: authority.publicKey,
      allowedExchangeRateChangeLowerBound: 9000, // -10%
      allowedExchangeRateChangeUpperBound: 11000, // +10%
      minimumUpdateDelayInSeconds: 3600, // 1 hour
      platformFeeBps: 100, // 1%
      performanceFeeBps: 1000, // 10%
      withdrawAuthority: authority.publicKey,
      strategist: authority.publicKey,
    };

    // Try with non-authority signer
    const nonAuthDeployIx = await program.methods
      .deploy(deployArgs)
      .accounts({
        // @ts-ignore
        config: programConfigAccount,
        boringVaultState: newVaultState,
        shareMint: newVaultShareMint,
        baseAsset: JITOSOL,
        signer: user.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .instruction();

    let txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      nonAuthDeployIx,
      [user]
    );
    ths.expectTxToFail(
      txResult.result,
      txResult.meta.logMessages,
      "Not authorized"
    );

    // Try with invalid authority (default address)
    const invalidAuthorityArgs = {
      ...deployArgs,
      authority: anchor.web3.PublicKey.default,
    };
    const invalidAuthorityIx = await program.methods
      .deploy(invalidAuthorityArgs)
      .accounts({
        // @ts-ignore
        config: programConfigAccount,
        boringVaultState: newVaultState,
        shareMint: newVaultShareMint,
        baseAsset: JITOSOL,
        signer: authority.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .instruction();

    txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      invalidAuthorityIx,
      [authority]
    );
    ths.expectTxToFail(
      txResult.result,
      txResult.meta.logMessages,
      "Invalid Authority"
    );

    // Try with invalid exchange rate provider (zero address)
    const invalidExchangeRateProviderArgs = {
      ...deployArgs,
      exchangeRateProvider: anchor.web3.PublicKey.default,
    };
    const invalidProviderIx = await program.methods
      .deploy(invalidExchangeRateProviderArgs)
      .accounts({
        // @ts-ignore
        config: programConfigAccount,
        boringVaultState: newVaultState,
        shareMint: newVaultShareMint,
        baseAsset: JITOSOL,
        signer: authority.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .instruction();

    txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      invalidProviderIx,
      [authority]
    );
    ths.expectTxToFail(
      txResult.result,
      txResult.meta.logMessages,
      "Invalid Exchange Rate Provider"
    );

    // Try with invalid payout address
    const invalidPayoutArgs = {
      ...deployArgs,
      payoutAddress: anchor.web3.PublicKey.default,
    };
    const invalidPayoutIx = await program.methods
      .deploy(invalidPayoutArgs)
      .accounts({
        // @ts-ignore
        config: programConfigAccount,
        boringVaultState: newVaultState,
        shareMint: newVaultShareMint,
        baseAsset: JITOSOL,
        signer: authority.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .instruction();

    txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      invalidPayoutIx,
      [authority]
    );
    ths.expectTxToFail(
      txResult.result,
      txResult.meta.logMessages,
      "Invalid Payout Address"
    );

    // Try with invalid exchange rate bounds (upper < BPS_SCALE)
    const invalidUpperBoundArgs = {
      ...deployArgs,
      allowedExchangeRateChangeUpperBound: 9999, // Less than BPS_SCALE (10000)
    };
    const invalidUpperBoundIx = await program.methods
      .deploy(invalidUpperBoundArgs)
      .accounts({
        // @ts-ignore
        config: programConfigAccount,
        boringVaultState: newVaultState,
        shareMint: newVaultShareMint,
        baseAsset: JITOSOL,
        signer: authority.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .instruction();

    txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      invalidUpperBoundIx,
      [authority]
    );
    ths.expectTxToFail(
      txResult.result,
      txResult.meta.logMessages,
      "Invalid Allowed Exchange Rate Change Upper Bound"
    );

    // Try with invalid exchange rate bounds (lower > BPS_SCALE)
    const invalidLowerBoundArgs = {
      ...deployArgs,
      allowedExchangeRateChangeLowerBound: 10_001, // Greater than BPS_SCALE (10000)
    };
    const invalidLowerBoundIx = await program.methods
      .deploy(invalidLowerBoundArgs)
      .accounts({
        // @ts-ignore
        config: programConfigAccount,
        boringVaultState: newVaultState,
        shareMint: newVaultShareMint,
        baseAsset: JITOSOL,
        signer: authority.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .instruction();

    txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      invalidLowerBoundIx,
      [authority]
    );
    ths.expectTxToFail(
      txResult.result,
      txResult.meta.logMessages,
      "Invalid Allowed Exchange Rate Change Lower Bound"
    );

    // Try with invalid platform fee
    const invalidPlatformFeeArgs = {
      ...deployArgs,
      platformFeeBps: 2001, // Greater than MAXIMUM_PLATFORM_FEE_BPS (2000)
    };
    const invalidPlatformFeeIx = await program.methods
      .deploy(invalidPlatformFeeArgs)
      .accounts({
        // @ts-ignore
        config: programConfigAccount,
        boringVaultState: newVaultState,
        shareMint: newVaultShareMint,
        baseAsset: JITOSOL,
        signer: authority.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .instruction();

    txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      invalidPlatformFeeIx,
      [authority]
    );
    ths.expectTxToFail(
      txResult.result,
      txResult.meta.logMessages,
      "Invalid Platform Fee BPS"
    );

    // Try with invalid performance fee
    const invalidPerformanceFeeArgs = {
      ...deployArgs,
      performanceFeeBps: 5001, // Greater than MAXIMUM_PERFORMANCE_FEE_BPS (5000)
    };
    const invalidPerformanceFeeIx = await program.methods
      .deploy(invalidPerformanceFeeArgs)
      .accounts({
        // @ts-ignore
        config: programConfigAccount,
        boringVaultState: newVaultState,
        shareMint: newVaultShareMint,
        baseAsset: JITOSOL,
        signer: authority.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .instruction();

    txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      invalidPerformanceFeeIx,
      [authority]
    );
    ths.expectTxToFail(
      txResult.result,
      txResult.meta.logMessages,
      "Invalid Performance Fee BPS"
    );
  });

  it("Pause/Unpause - authority validation", async () => {
    // Try to pause with non-authority signer
    const pauseIx = await program.methods
      .pause(new anchor.BN(0))
      .accounts({
        signer: user.publicKey, // Non-authority signer
        boringVaultState: boringVaultStateAccount,
      })
      .instruction();

    let txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      pauseIx,
      [user]
    );
    ths.expectTxToFail(
      txResult.result,
      txResult.meta.logMessages,
      "Not authorized"
    );

    // Try to unpause with non-authority signer
    const unpauseIx = await program.methods
      .unpause(new anchor.BN(0))
      .accounts({
        signer: user.publicKey, // Non-authority signer
        boringVaultState: boringVaultStateAccount,
      })
      .instruction();

    txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      unpauseIx,
      [user]
    );
    ths.expectTxToFail(
      txResult.result,
      txResult.meta.logMessages,
      "Not authorized"
    );
  });

  it("Authority transfer - failure cases", async () => {
    // Try to transfer authority with non-authority signer
    const transferIx = await program.methods
      .transferAuthority(new anchor.BN(0), authority.publicKey)
      .accounts({
        signer: user.publicKey, // Non-authority signer
        boringVaultState: boringVaultStateAccount,
      })
      .instruction();

    let txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      transferIx,
      [user]
    );
    ths.expectTxToFail(
      txResult.result,
      txResult.meta.logMessages,
      "Not authorized"
    );

    // First do a valid transfer to set up accept test
    const validTransferIx = await program.methods
      .transferAuthority(new anchor.BN(0), user.publicKey)
      .accounts({
        signer: authority.publicKey,
        boringVaultState: boringVaultStateAccount,
      })
      .instruction();

    txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      validTransferIx,
      [authority]
    );
    ths.expectTxToSucceed(txResult.result);

    // Try to accept authority with non-pending authority
    const invalidAcceptIx = await program.methods
      .acceptAuthority(new anchor.BN(0))
      .accounts({
        signer: authority.publicKey, // Not the pending authority
        boringVaultState: boringVaultStateAccount,
      })
      .instruction();

    txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      invalidAcceptIx,
      [authority]
    );
    ths.expectTxToFail(
      txResult.result,
      txResult.meta.logMessages,
      "Not authorized"
    );
  });

  it("Update asset data - failure cases", async () => {
    const vaultId = new anchor.BN(0);

    // Setup basic args
    const updateArgs = {
      vaultId: vaultId,
      assetData: {
        allowDeposits: true,
        allowWithdrawals: true,
        sharePremiumBps: 0,
        isPeggedToBaseAsset: false,
        priceFeed: new anchor.web3.PublicKey(
          "Feed111111111111111111111111111111111111111"
        ),
        inversePriceFeed: false,
      },
    };

    // Get PDA for asset data
    const [assetDataPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("asset-data"),
        boringVaultStateAccount.toBuffer(),
        JITOSOL.toBuffer(),
      ],
      program.programId
    );

    // Try with non-authority signer
    const nonAuthUpdateIx = await program.methods
      .updateAssetData(updateArgs)
      .accounts({
        signer: user.publicKey, // Non-authority signer
        boringVaultState: boringVaultStateAccount,
        asset: JITOSOL,
        // @ts-ignore
        assetData: assetDataPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .instruction();

    let txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      nonAuthUpdateIx,
      [user]
    );
    ths.expectTxToFail(
      txResult.result,
      txResult.meta.logMessages,
      "Not authorized"
    );

    // Try with invalid price feed (zero address) for non-pegged asset
    const invalidPriceFeedArgs = {
      vaultId: vaultId,
      // @ts-ignore
      assetData: {
        ...updateArgs.assetData,
        isPeggedToBaseAsset: false,
        priceFeed: anchor.web3.PublicKey.default,
      },
    };
    const invalidPriceFeedIx = await program.methods
      .updateAssetData(invalidPriceFeedArgs)
      .accounts({
        signer: authority.publicKey,
        boringVaultState: boringVaultStateAccount,
        asset: JITOSOL,
        // @ts-ignore
        assetData: assetDataPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .instruction();

    txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      invalidPriceFeedIx,
      [authority]
    );
    ths.expectTxToFail(
      txResult.result,
      txResult.meta.logMessages,
      "Invalid Price Feed"
    );

    // This should succeed - zero address price feed for pegged asset
    const peggedAssetArgs = {
      vaultId: vaultId,
      // @ts-ignore
      assetData: {
        ...updateArgs.assetData,
        isPeggedToBaseAsset: true,
        priceFeed: anchor.web3.PublicKey.default,
      },
    };
    const validPeggedIx = await program.methods
      .updateAssetData(peggedAssetArgs)
      .accounts({
        signer: authority.publicKey,
        boringVaultState: boringVaultStateAccount,
        asset: JITOSOL,
        // @ts-ignore
        assetData: assetDataPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .instruction();

    txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      validPeggedIx,
      [authority]
    );
    ths.expectTxToSucceed(txResult.result);
  });

  it("Deposit SOL - enforces constraints and updates state correctly", async () => {
    const depositArgs = {
      vaultId: new anchor.BN(0),
      depositAmount: new anchor.BN(1_000_000_000), // 1 SOL
      minMintAmount: new anchor.BN(900_000_000), // 0.9 shares minimum
    };

    // Try to deposit when vault is paused
    // First pause the vault
    const pauseIx = await program.methods
      .pause(new anchor.BN(0))
      .accounts({
        signer: authority.publicKey,
        boringVaultState: boringVaultStateAccount,
      })
      .instruction();

    let txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      pauseIx,
      [authority]
    );
    ths.expectTxToSucceed(txResult.result);

    // Now try to deposit
    const pausedDepositIx = await program.methods
      .depositSol(depositArgs)
      .accounts({
        signer: user.publicKey,
        // @ts-ignore
        tokenProgram2022: TOKEN_2022_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        boringVaultState: boringVaultStateAccount,
        boringVault: boringVaultAccount,
        assetData: solAssetDataPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        shareMint: boringVaultShareMint,
        userShares: userShareAta,
        priceFeed: JITOSOL_SOL_ORACLE,
      })
      .instruction();

    txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      pausedDepositIx,
      [user]
    );
    ths.expectTxToFail(
      txResult.result,
      txResult.meta.logMessages,
      "Vault paused"
    );

    // Unpause vault but disable deposits in asset data
    const unpauseIx = await program.methods
      .unpause(new anchor.BN(0))
      .accounts({
        signer: authority.publicKey,
        boringVaultState: boringVaultStateAccount,
      })
      .instruction();

    txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      unpauseIx,
      [authority]
    );
    ths.expectTxToSucceed(txResult.result);

    // Update asset data to disable deposits
    const updateAssetDataIx = await program.methods
      .updateAssetData({
        vaultId: new anchor.BN(0),
        assetData: {
          allowDeposits: false,
          allowWithdrawals: true,
          sharePremiumBps: 0,
          isPeggedToBaseAsset: false,
          priceFeed: JITOSOL_SOL_ORACLE,
          inversePriceFeed: false,
        },
      })
      .accounts({
        signer: authority.publicKey,
        boringVaultState: boringVaultStateAccount,
        asset: anchor.web3.PublicKey.default,
        // @ts-ignore
        assetData: solAssetDataPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .instruction();

    txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      updateAssetDataIx,
      [authority]
    );
    ths.expectTxToSucceed(txResult.result);

    // Try to deposit when deposits are disabled
    const disabledDepositIx = await program.methods
      .depositSol(depositArgs)
      .accounts({
        signer: user.publicKey,
        // @ts-ignore
        tokenProgram2022: TOKEN_2022_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        boringVaultState: boringVaultStateAccount,
        boringVault: boringVaultAccount,
        assetData: solAssetDataPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        shareMint: boringVaultShareMint,
        userShares: userShareAta,
        priceFeed: JITOSOL_SOL_ORACLE,
      })
      .instruction();

    txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      disabledDepositIx,
      [user]
    );
    ths.expectTxToFail(
      txResult.result,
      txResult.meta.logMessages,
      "Asset not allowed"
    );

    // Restore asset data to allow deposits
    const restoreAssetDataIx = await program.methods
      .updateAssetData({
        vaultId: new anchor.BN(0),
        assetData: {
          allowDeposits: true,
          allowWithdrawals: true,
          sharePremiumBps: 0,
          isPeggedToBaseAsset: false,
          priceFeed: JITOSOL_SOL_ORACLE,
          inversePriceFeed: false,
        },
      })
      .accounts({
        signer: authority.publicKey,
        boringVaultState: boringVaultStateAccount,
        asset: anchor.web3.PublicKey.default,
        // @ts-ignore
        assetData: solAssetDataPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .instruction();

    txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      restoreAssetDataIx,
      [authority]
    );
    ths.expectTxToSucceed(txResult.result);

    // Try deposit with too high minMintAmount
    const highSlippageArgs = {
      vaultId: new anchor.BN(0),
      depositAmount: new anchor.BN(1_000_000_000), // 1 SOL
      minMintAmount: new anchor.BN(2_000_000_000), // 2 shares minimum (impossible given 1 SOL deposit)
    };

    const highSlippageIx = await program.methods
      .depositSol(highSlippageArgs)
      .accounts({
        signer: user.publicKey,
        // @ts-ignore
        tokenProgram2022: TOKEN_2022_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        boringVaultState: boringVaultStateAccount,
        boringVault: boringVaultAccount,
        assetData: solAssetDataPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        shareMint: boringVaultShareMint,
        userShares: userShareAta,
        priceFeed: JITOSOL_SOL_ORACLE,
      })
      .instruction();

    txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      highSlippageIx,
      [user]
    );
    ths.expectTxToFail(
      txResult.result,
      txResult.meta.logMessages,
      "Slippage tolerance exceeded"
    );

    // Get initial balances
    const initialUserSol = await client.getBalance(user.publicKey);
    const initialVaultSol = await client.getBalance(boringVaultAccount);
    const initialUserShares = await ths.getTokenBalance(client, userShareAta);

    // Try a successful deposit after restoring deposits
    const successDepositIx = await program.methods
      .depositSol(depositArgs)
      .accounts({
        signer: user.publicKey,
        // @ts-ignore
        tokenProgram2022: TOKEN_2022_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        boringVaultState: boringVaultStateAccount,
        boringVault: boringVaultAccount,
        assetData: solAssetDataPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        shareMint: boringVaultShareMint,
        userShares: userShareAta,
        priceFeed: JITOSOL_SOL_ORACLE,
      })
      .instruction();

    txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      successDepositIx,
      [user]
    );
    ths.expectTxToSucceed(txResult.result);

    let expectedShares = ths.getU64ReturnFromLogs(txResult);

    // Get final balances
    const finalUserSol = await client.getBalance(user.publicKey);
    const finalVaultSol = await client.getBalance(boringVaultAccount);
    const finalUserShares = await ths.getTokenBalance(client, userShareAta);

    // Verify state changes
    expect(Number(finalUserSol)).to.equal(
      Number(initialUserSol) - depositArgs.depositAmount.toNumber()
    );
    expect(Number(finalVaultSol)).to.equal(
      Number(initialVaultSol) + depositArgs.depositAmount.toNumber()
    );
    expect(Number(finalUserShares)).to.equal(
      Number(initialUserShares) + expectedShares
    );
  });

  it("Deposit - enforces constraints and updates state correctly", async () => {
    const depositArgs = {
      vaultId: new anchor.BN(0),
      depositAmount: new anchor.BN(1_000_000_000),
      minMintAmount: new anchor.BN(900_000_000),
    };

    // Try deposit with invalid user ATA (using vault's ATA instead)
    const invalidUserAtaIx = await program.methods
      .deposit(depositArgs)
      .accounts({
        signer: user.publicKey,
        // @ts-ignore
        tokenProgram2022: TOKEN_2022_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        boringVaultState: boringVaultStateAccount,
        boringVault: boringVaultAccount,
        assetData: jitoSolAssetDataPda,
        depositMint: JITOSOL,
        userAta: vaultJitoSolAta, // Using vault's ATA instead of user's
        vaultAta: vaultJitoSolAta,
        shareMint: boringVaultShareMint,
        userShares: userShareAta,
        priceFeed: anchor.web3.PublicKey.default,
      })
      .instruction();

    let txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      invalidUserAtaIx,
      [user]
    );
    ths.expectTxToFail(
      txResult.result,
      txResult.meta.logMessages,
      "Invalid Token Account"
    );

    // Try deposit with invalid vault ATA (using user's ATA instead)
    const invalidVaultAtaIx = await program.methods
      .deposit(depositArgs)
      .accounts({
        signer: user.publicKey,
        // @ts-ignore
        tokenProgram2022: TOKEN_2022_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        boringVaultState: boringVaultStateAccount,
        boringVault: boringVaultAccount,
        assetData: jitoSolAssetDataPda,
        depositMint: JITOSOL,
        userAta: userJitoSolAta,
        vaultAta: userJitoSolAta, // Using user's ATA instead of vault's
        shareMint: boringVaultShareMint,
        userShares: userShareAta,
        priceFeed: anchor.web3.PublicKey.default,
      })
      .instruction();

    txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      invalidVaultAtaIx,
      [user]
    );
    ths.expectTxToFail(
      txResult.result,
      txResult.meta.logMessages,
      "Invalid Token Account"
    );

    // Try to deposit when vault is paused
    // First pause the vault
    const pauseIx = await program.methods
      .pause(new anchor.BN(0))
      .accounts({
        signer: authority.publicKey,
        boringVaultState: boringVaultStateAccount,
      })
      .instruction();

    txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      pauseIx,
      [authority]
    );
    ths.expectTxToSucceed(txResult.result);

    // Try deposit when paused
    const pausedDepositIx = await program.methods
      .deposit(depositArgs)
      .accounts({
        signer: user.publicKey,
        // @ts-ignore
        tokenProgram2022: TOKEN_2022_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        boringVaultState: boringVaultStateAccount,
        boringVault: boringVaultAccount,
        assetData: jitoSolAssetDataPda,
        depositMint: JITOSOL,
        userAta: userJitoSolAta,
        vaultAta: vaultJitoSolAta,
        shareMint: boringVaultShareMint,
        userShares: userShareAta,
        priceFeed: anchor.web3.PublicKey.default,
      })
      .instruction();

    txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      pausedDepositIx,
      [user]
    );
    ths.expectTxToFail(
      txResult.result,
      txResult.meta.logMessages,
      "Vault paused"
    );

    // Unpause vault but disable deposits in asset data
    const unpauseIx = await program.methods
      .unpause(new anchor.BN(0))
      .accounts({
        signer: authority.publicKey,
        boringVaultState: boringVaultStateAccount,
      })
      .instruction();

    txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      unpauseIx,
      [authority]
    );
    ths.expectTxToSucceed(txResult.result);

    // Update asset data to disable deposits
    const updateAssetDataIx = await program.methods
      .updateAssetData({
        vaultId: new anchor.BN(0),
        assetData: {
          allowDeposits: false,
          allowWithdrawals: true,
          sharePremiumBps: 0,
          isPeggedToBaseAsset: true,
          priceFeed: anchor.web3.PublicKey.default,
          inversePriceFeed: false,
        },
      })
      .accounts({
        signer: authority.publicKey,
        boringVaultState: boringVaultStateAccount,
        asset: JITOSOL,
        // @ts-ignore
        assetData: jitoSolAssetDataPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .instruction();

    txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      updateAssetDataIx,
      [authority]
    );
    ths.expectTxToSucceed(txResult.result);

    // Try deposit when deposits are disabled
    const disabledDepositIx = await program.methods
      .deposit(depositArgs)
      .accounts({
        signer: user.publicKey,
        // @ts-ignore
        tokenProgram2022: TOKEN_2022_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        boringVaultState: boringVaultStateAccount,
        boringVault: boringVaultAccount,
        assetData: jitoSolAssetDataPda,
        depositMint: JITOSOL,
        userAta: userJitoSolAta,
        vaultAta: vaultJitoSolAta,
        shareMint: boringVaultShareMint,
        userShares: userShareAta,
        priceFeed: anchor.web3.PublicKey.default,
      })
      .instruction();

    txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      disabledDepositIx,
      [user]
    );
    ths.expectTxToFail(
      txResult.result,
      txResult.meta.logMessages,
      "Asset not allowed"
    );

    // Re-enable deposits
    const restoreAssetDataIx = await program.methods
      .updateAssetData({
        vaultId: new anchor.BN(0),
        assetData: {
          allowDeposits: true,
          allowWithdrawals: true,
          sharePremiumBps: 0,
          isPeggedToBaseAsset: true,
          priceFeed: anchor.web3.PublicKey.default,
          inversePriceFeed: false,
        },
      })
      .accounts({
        signer: authority.publicKey,
        boringVaultState: boringVaultStateAccount,
        asset: JITOSOL,
        assetData: jitoSolAssetDataPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .instruction();

    txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      restoreAssetDataIx,
      [authority]
    );
    ths.expectTxToSucceed(txResult.result);

    // Try deposit with too high minMintAmount (slippage)
    const highSlippageArgs = {
      vaultId: new anchor.BN(0),
      depositAmount: new anchor.BN(1_000_000_000),
      minMintAmount: new anchor.BN(100_000_000_000), // Unreasonably high min shares
    };

    const slippageDepositIx = await program.methods
      .deposit(highSlippageArgs)
      .accounts({
        signer: user.publicKey,
        // @ts-ignore
        tokenProgram2022: TOKEN_2022_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        boringVaultState: boringVaultStateAccount,
        boringVault: boringVaultAccount,
        assetData: jitoSolAssetDataPda,
        depositMint: JITOSOL,
        userAta: userJitoSolAta,
        vaultAta: vaultJitoSolAta,
        shareMint: boringVaultShareMint,
        userShares: userShareAta,
        priceFeed: anchor.web3.PublicKey.default,
      })
      .instruction();

    txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      slippageDepositIx,
      [user]
    );
    ths.expectTxToFail(
      txResult.result,
      txResult.meta.logMessages,
      "Slippage tolerance exceeded"
    );

    // Get initial balances
    const initialUserTokens = await ths.getTokenBalance(client, userJitoSolAta);
    const initialVaultTokens = await ths.getTokenBalance(
      client,
      vaultJitoSolAta
    );
    const initialUserShares = await ths.getTokenBalance(client, userShareAta);

    // Try a successful deposit
    const successDepositIx = await program.methods
      .deposit(depositArgs)
      .accounts({
        signer: user.publicKey,
        // @ts-ignore
        tokenProgram2022: TOKEN_2022_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        boringVaultState: boringVaultStateAccount,
        boringVault: boringVaultAccount,
        assetData: jitoSolAssetDataPda,
        depositMint: JITOSOL,
        userAta: userJitoSolAta,
        vaultAta: vaultJitoSolAta,
        shareMint: boringVaultShareMint,
        userShares: userShareAta,
        priceFeed: anchor.web3.PublicKey.default,
      })
      .instruction();

    txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      successDepositIx,
      [user]
    );
    ths.expectTxToSucceed(txResult.result);

    let expectedShares = ths.getU64ReturnFromLogs(txResult);

    // Get final balances
    const finalUserTokens = await ths.getTokenBalance(client, userJitoSolAta);
    const finalVaultTokens = await ths.getTokenBalance(client, vaultJitoSolAta);
    const finalUserShares = await ths.getTokenBalance(client, userShareAta);

    // Verify state changes
    expect(Number(finalUserTokens)).to.equal(
      Number(initialUserTokens) - depositArgs.depositAmount.toNumber()
    );
    expect(Number(finalVaultTokens)).to.equal(
      Number(initialVaultTokens) + depositArgs.depositAmount.toNumber()
    );
    expect(Number(finalUserShares)).to.equal(
      Number(initialUserShares) + expectedShares
    );
  });

  it("Withdraw - enforces constraints and updates state correctly", async () => {
    const withdrawArgs = {
      vaultId: new anchor.BN(0),
      shareAmount: new anchor.BN(1_000_000_000),
      minAssetsAmount: new anchor.BN(900_000_000),
    };

    // Try withdraw with invalid user ATA (using vault's ATA instead)
    const invalidUserAtaIx = await program.methods
      .withdraw(withdrawArgs)
      .accounts({
        signer: user.publicKey,
        // @ts-ignore
        tokenProgram2022: TOKEN_2022_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        boringVaultState: boringVaultStateAccount,
        boringVault: boringVaultAccount,
        withdrawMint: JITOSOL,
        assetData: jitoSolAssetDataPda,
        userAta: vaultJitoSolAta, // Using vault's ATA instead of user's
        vaultAta: vaultJitoSolAta,
        shareMint: boringVaultShareMint,
        userShares: userShareAta,
        priceFeed: anchor.web3.PublicKey.default,
      })
      .instruction();

    let txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      invalidUserAtaIx,
      [user]
    );
    ths.expectTxToFail(
      txResult.result,
      txResult.meta.logMessages,
      "Invalid Token Account"
    );

    // Try withdraw with invalid vault ATA (using user's ATA instead)
    const invalidVaultAtaIx = await program.methods
      .withdraw(withdrawArgs)
      .accounts({
        signer: user.publicKey,
        // @ts-ignore
        tokenProgram2022: TOKEN_2022_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        boringVaultState: boringVaultStateAccount,
        boringVault: boringVaultAccount,
        withdrawMint: JITOSOL,
        assetData: jitoSolAssetDataPda,
        userAta: userJitoSolAta,
        vaultAta: userJitoSolAta, // Using user's ATA instead of vault's
        shareMint: boringVaultShareMint,
        userShares: userShareAta,
        priceFeed: anchor.web3.PublicKey.default,
      })
      .instruction();

    txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      invalidVaultAtaIx,
      [user]
    );
    ths.expectTxToFail(
      txResult.result,
      txResult.meta.logMessages,
      "Invalid Token Account"
    );

    // Try to withdraw when vault is paused
    // First pause the vault
    const pauseIx = await program.methods
      .pause(new anchor.BN(0))
      .accounts({
        signer: authority.publicKey,
        boringVaultState: boringVaultStateAccount,
      })
      .instruction();

    txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      pauseIx,
      [authority]
    );
    ths.expectTxToSucceed(txResult.result);

    // Try withdraw when paused
    const pausedWithdrawIx = await program.methods
      .withdraw(withdrawArgs)
      .accounts({
        signer: user.publicKey,
        // @ts-ignore
        tokenProgram2022: TOKEN_2022_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        boringVaultState: boringVaultStateAccount,
        boringVault: boringVaultAccount,
        withdrawMint: JITOSOL,
        assetData: jitoSolAssetDataPda,
        userAta: userJitoSolAta,
        vaultAta: vaultJitoSolAta,
        shareMint: boringVaultShareMint,
        userShares: userShareAta,
        priceFeed: anchor.web3.PublicKey.default,
      })
      .instruction();

    txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      pausedWithdrawIx,
      [user]
    );
    ths.expectTxToFail(
      txResult.result,
      txResult.meta.logMessages,
      "Vault paused"
    );

    // Unpause vault but disable withdrawals in asset data
    const unpauseIx = await program.methods
      .unpause(new anchor.BN(0))
      .accounts({
        signer: authority.publicKey,
        boringVaultState: boringVaultStateAccount,
      })
      .instruction();

    txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      unpauseIx,
      [authority]
    );
    ths.expectTxToSucceed(txResult.result);

    // Update asset data to disable withdrawals
    const updateAssetDataIx = await program.methods
      .updateAssetData({
        vaultId: new anchor.BN(0),
        assetData: {
          allowDeposits: true,
          allowWithdrawals: false,
          sharePremiumBps: 0,
          isPeggedToBaseAsset: true,
          priceFeed: anchor.web3.PublicKey.default,
          inversePriceFeed: false,
        },
      })
      .accounts({
        signer: authority.publicKey,
        boringVaultState: boringVaultStateAccount,
        asset: JITOSOL,
        // @ts-ignore
        assetData: jitoSolAssetDataPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .instruction();

    txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      updateAssetDataIx,
      [authority]
    );
    ths.expectTxToSucceed(txResult.result);

    // Try withdraw when withdrawals are disabled
    const disabledWithdrawIx = await program.methods
      .withdraw(withdrawArgs)
      .accounts({
        signer: user.publicKey,
        // @ts-ignore
        tokenProgram2022: TOKEN_2022_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        boringVaultState: boringVaultStateAccount,
        boringVault: boringVaultAccount,
        withdrawMint: JITOSOL,
        assetData: jitoSolAssetDataPda,
        userAta: userJitoSolAta,
        vaultAta: vaultJitoSolAta,
        shareMint: boringVaultShareMint,
        userShares: userShareAta,
        priceFeed: anchor.web3.PublicKey.default,
      })
      .instruction();

    txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      disabledWithdrawIx,
      [user]
    );
    ths.expectTxToFail(
      txResult.result,
      txResult.meta.logMessages,
      "Asset not allowed"
    );

    // Re-enable withdrawals
    const restoreAssetDataIx = await program.methods
      .updateAssetData({
        vaultId: new anchor.BN(0),
        assetData: {
          allowDeposits: true,
          allowWithdrawals: true,
          sharePremiumBps: 0,
          isPeggedToBaseAsset: true,
          priceFeed: anchor.web3.PublicKey.default,
          inversePriceFeed: false,
        },
      })
      .accounts({
        signer: authority.publicKey,
        boringVaultState: boringVaultStateAccount,
        asset: JITOSOL,
        // @ts-ignore
        assetData: jitoSolAssetDataPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .instruction();

    txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      restoreAssetDataIx,
      [authority]
    );
    ths.expectTxToSucceed(txResult.result);

    // Get initial balances
    const initialUserTokens = await ths.getTokenBalance(client, userJitoSolAta);
    const initialVaultTokens = await ths.getTokenBalance(
      client,
      vaultJitoSolAta
    );
    const initialUserShares = await ths.getTokenBalance(client, userShareAta);

    // Try a successful withdraw
    const successWithdrawIx = await program.methods
      .withdraw(withdrawArgs)
      .accounts({
        signer: user.publicKey,
        // @ts-ignore
        tokenProgram2022: TOKEN_2022_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        boringVaultState: boringVaultStateAccount,
        boringVault: boringVaultAccount,
        withdrawMint: JITOSOL,
        assetData: jitoSolAssetDataPda,
        userAta: userJitoSolAta,
        vaultAta: vaultJitoSolAta,
        shareMint: boringVaultShareMint,
        userShares: userShareAta,
        priceFeed: anchor.web3.PublicKey.default,
      })
      .instruction();

    txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      successWithdrawIx,
      [user]
    );
    ths.expectTxToSucceed(txResult.result);

    let expectedAssets = ths.getU64ReturnFromLogs(txResult);

    // Get final balances
    const finalUserTokens = await ths.getTokenBalance(client, userJitoSolAta);
    const finalVaultTokens = await ths.getTokenBalance(client, vaultJitoSolAta);
    const finalUserShares = await ths.getTokenBalance(client, userShareAta);

    // Verify state changes
    expect(Number(finalUserTokens)).to.equal(
      Number(initialUserTokens) + expectedAssets
    );
    expect(Number(finalVaultTokens)).to.be.lessThan(Number(initialVaultTokens));
    expect(Number(finalUserShares)).to.equal(
      Number(initialUserShares) - withdrawArgs.shareAmount.toNumber()
    );

    // Set withdraw authority and try withdraw again
    let someOtherAuthority = anchor.web3.Keypair.generate();
    const setWithdrawAuthorityIx = await program.methods
      .setWithdrawAuthority(new anchor.BN(0), someOtherAuthority.publicKey)
      .accounts({
        signer: authority.publicKey,
        boringVaultState: boringVaultStateAccount,
      })
      .instruction();

    txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      setWithdrawAuthorityIx,
      [authority]
    );
    ths.expectTxToSucceed(txResult.result);

    // Try withdraw with non-authority user
    const unauthorizedWithdrawIx = await program.methods
      .withdraw(withdrawArgs)
      .accounts({
        signer: user.publicKey, // Not the withdraw authority
        // @ts-ignore
        tokenProgram2022: TOKEN_2022_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        boringVaultState: boringVaultStateAccount,
        boringVault: boringVaultAccount,
        withdrawMint: JITOSOL,
        assetData: jitoSolAssetDataPda,
        userAta: userJitoSolAta,
        vaultAta: vaultJitoSolAta,
        shareMint: boringVaultShareMint,
        userShares: userShareAta,
        priceFeed: anchor.web3.PublicKey.default,
      })
      .instruction();

    txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      unauthorizedWithdrawIx,
      [user]
    );
    ths.expectTxToFail(
      txResult.result,
      txResult.meta.logMessages,
      "Not authorized"
    );
  });

  it("Update Exchange Rate - failure cases", async () => {
    // Try to update exchange rate with non-provider account
    const unauthorizedUpdateIx = await program.methods
      .updateExchangeRate(new anchor.BN(0), new anchor.BN(1_100_000_000))
      .accounts({
        signer: user.publicKey, // Not the exchange rate provider
        boringVaultState: boringVaultStateAccount,
        // @ts-ignore
        shareMint: boringVaultShareMint,
        clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
      })
      .instruction();

    let txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      unauthorizedUpdateIx,
      [user]
    );
    ths.expectTxToFail(
      txResult.result,
      txResult.meta.logMessages,
      "Not authorized"
    );

    // Pause the vault
    const pauseIx = await program.methods
      .pause(new anchor.BN(0))
      .accounts({
        signer: authority.publicKey,
        boringVaultState: boringVaultStateAccount,
      })
      .instruction();

    txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      pauseIx,
      [authority]
    );
    ths.expectTxToSucceed(txResult.result);

    // Try to update exchange rate when paused
    const pausedUpdateIx = await program.methods
      .updateExchangeRate(new anchor.BN(0), new anchor.BN(1_100_000_000))
      .accounts({
        signer: strategist.publicKey,
        boringVaultState: boringVaultStateAccount,
        // @ts-ignore
        shareMint: boringVaultShareMint,
        clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
      })
      .instruction();

    txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      pausedUpdateIx,
      [strategist]
    );
    ths.expectTxToFail(
      txResult.result,
      txResult.meta.logMessages,
      "Vault paused"
    );

    // Unpause the vault for future tests
    const unpauseIx = await program.methods
      .unpause(new anchor.BN(0))
      .accounts({
        signer: authority.publicKey,
        boringVaultState: boringVaultStateAccount,
      })
      .instruction();

    txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      unpauseIx,
      [authority]
    );
    ths.expectTxToSucceed(txResult.result);
  });

  it("Manage - enforces constraints and executes CPIs correctly", async () => {
    // Setup transfer instruction from sub-account 0 to 1
    const transferAmount = new anchor.BN(1_234_567_890); // 1.234567890 SOL
    const transfer0to1IxData = CpiService.createTransferIxData(
      transferAmount.toNumber()
    );

    const [boringVaultSubAccount1] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [
          Buffer.from("boring-vault"),
          new anchor.BN(0).toArrayLike(Buffer, "le", 8),
          Buffer.from([1]), // sub-account 1
        ],
        program.programId
      );

    const transfer0to1Accounts = [
      { pubkey: boringVaultAccount, isWritable: true, isSigner: false }, // from (sub-account 0)
      { pubkey: boringVaultSubAccount1, isWritable: true, isSigner: false }, // to (sub-account 1)
      {
        pubkey: anchor.web3.SystemProgram.programId,
        isWritable: false,
        isSigner: false,
      },
    ];

    // Setup transfer instruction from sub-account 1 back to 0
    const transfer1to0IxData = CpiService.createTransferIxData(
      transferAmount.toNumber()
    );

    const transfer1to0Accounts = [
      { pubkey: boringVaultSubAccount1, isWritable: true, isSigner: false }, // from (sub-account 1)
      { pubkey: boringVaultAccount, isWritable: true, isSigner: false }, // to (sub-account 0)
      {
        pubkey: anchor.web3.SystemProgram.programId,
        isWritable: false,
        isSigner: false,
      },
    ];

    // Get CPI digests
    const digest0to1 = await program.methods
      .viewCpiDigest(
        // @ts-ignore
        {
          vaultId: new anchor.BN(0),
          subAccount: 0,
          ixProgramId: anchor.web3.SystemProgram.programId,
          ixData: transfer0to1IxData,
          operators: CpiService.getWSolTransferOperators(),
          expectedSize: 104,
        }
      )
      .signers([deployer])
      .remainingAccounts(transfer0to1Accounts)
      .view();

    const [cpiDigest0to1Account] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("cpi-digest"),
        boringVaultStateAccount.toBuffer(),
        Buffer.from(digest0to1),
      ],
      program.programId
    );

    // Update CPI digest
    const updateDigestIx = await program.methods
      .updateCpiDigest({
        vaultId: new anchor.BN(0),
        cpiDigest: digest0to1,
        isValid: true,
      })
      .accounts({
        signer: authority.publicKey,
        boringVaultState: boringVaultStateAccount,
        // @ts-ignore
        systemProgram: anchor.web3.SystemProgram.programId,
        cpiDigest: cpiDigest0to1Account,
      })
      .instruction();

    let txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      updateDigestIx,
      [authority]
    );
    ths.expectTxToSucceed(txResult.result);

    const pauseIx = await program.methods
      .pause(new anchor.BN(0))
      .accounts({
        signer: authority.publicKey,
        boringVaultState: boringVaultStateAccount,
      })
      .instruction();

    txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      pauseIx,
      [authority]
    );
    ths.expectTxToSucceed(txResult.result);

    // Attempt manage while paused
    const pausedManageIx = await program.methods
      .manage(
        // @ts-ignore
        {
          vaultId: new anchor.BN(0),
          subAccount: 0,
          ixProgramId: anchor.web3.SystemProgram.programId,
          ixData: transfer0to1IxData,
          operators: CpiService.getWSolTransferOperators(),
          expectedSize: 104,
        }
      )
      .accounts({
        signer: strategist.publicKey,
        boringVaultState: boringVaultStateAccount,
        boringVault: boringVaultAccount,
        cpiDigest: cpiDigest0to1Account,
      })
      .remainingAccounts(transfer0to1Accounts)
      .instruction();

    txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      pausedManageIx,
      [strategist]
    );
    ths.expectTxToFail(
      txResult.result,
      txResult.meta.logMessages,
      "Vault paused"
    );

    // Unpause vault
    const unpauseIx = await program.methods
      .unpause(new anchor.BN(0))
      .accounts({
        signer: authority.publicKey,
        boringVaultState: boringVaultStateAccount,
      })
      .instruction();

    txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      unpauseIx,
      [authority]
    );
    ths.expectTxToSucceed(txResult.result);

    // Try to manage with non-strategist
    const nonStrategist = anchor.web3.Keypair.generate();
    const unauthorizedManageIx = await program.methods
      .manage(
        // @ts-ignore
        {
          vaultId: new anchor.BN(0),
          subAccount: 0,
          ixProgramId: anchor.web3.SystemProgram.programId,
          ixData: transfer0to1IxData,
          operators: CpiService.getWSolTransferOperators(),
          expectedSize: 104,
        }
      )
      .accounts({
        signer: nonStrategist.publicKey,
        boringVaultState: boringVaultStateAccount,
        boringVault: boringVaultAccount,
        cpiDigest: cpiDigest0to1Account,
      })
      .remainingAccounts(transfer0to1Accounts)
      .instruction();

    txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      unauthorizedManageIx,
      [nonStrategist]
    );
    ths.expectTxToFail(
      txResult.result,
      txResult.meta.logMessages,
      "Not authorized"
    );

    // Setup second CPI digest (1->0)
    const digest1to0 = await program.methods
      .viewCpiDigest(
        // @ts-ignore
        {
          vaultId: new anchor.BN(0),
          ixProgramId: anchor.web3.SystemProgram.programId,
          ixData: transfer1to0IxData,
          operators: CpiService.getWSolTransferOperators(),
          expectedSize: 104,
        }
      )
      .signers([deployer])
      .remainingAccounts(transfer1to0Accounts)
      .view();

    const [cpiDigest1to0Account] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("cpi-digest"),
        boringVaultStateAccount.toBuffer(),
        Buffer.from(digest1to0),
      ],
      program.programId
    );

    // Update second CPI digest
    const updateDigest1to0Ix = await program.methods
      .updateCpiDigest({
        vaultId: new anchor.BN(0),
        cpiDigest: digest1to0,
        isValid: true,
      })
      .accounts({
        signer: authority.publicKey,
        boringVaultState: boringVaultStateAccount,
        // @ts-ignore
        systemProgram: anchor.web3.SystemProgram.programId,
        cpiDigest: cpiDigest1to0Account,
      })
      .instruction();

    txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      updateDigest1to0Ix,
      [authority]
    );
    ths.expectTxToSucceed(txResult.result);

    // Try to execute transfer 0->1 with wrong digest (using 1->0 digest)
    const wrongDigestManageIx = await program.methods
      .manage(
        // @ts-ignore
        {
          vaultId: new anchor.BN(0),
          subAccount: 0,
          ixProgramId: anchor.web3.SystemProgram.programId,
          ixData: transfer0to1IxData,
          operators: CpiService.getWSolTransferOperators(),
          expectedSize: 104,
        }
      )
      .accounts({
        signer: strategist.publicKey,
        boringVaultState: boringVaultStateAccount,
        boringVault: boringVaultAccount,
        cpiDigest: cpiDigest1to0Account, // Wrong digest!
      })
      .remainingAccounts(transfer0to1Accounts)
      .instruction();

    txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      wrongDigestManageIx,
      [strategist]
    );
    ths.expectTxToFail(
      txResult.result,
      txResult.meta.logMessages,
      "Invalid CPI Digest"
    );

    // Execute successful transfer 0->1
    const initialBalance0 = await client.getBalance(boringVaultAccount);
    const initialBalance1 = await client.getBalance(boringVaultSubAccount1);

    const manage0to1Ix = await program.methods
      .manage(
        // @ts-ignore
        {
          vaultId: new anchor.BN(0),
          subAccount: 0,
          ixProgramId: anchor.web3.SystemProgram.programId,
          ixData: transfer0to1IxData,
          operators: CpiService.getWSolTransferOperators(),
          expectedSize: 104,
        }
      )
      .accounts({
        signer: strategist.publicKey,
        boringVaultState: boringVaultStateAccount,
        boringVault: boringVaultAccount,
        cpiDigest: cpiDigest0to1Account,
      })
      .remainingAccounts(transfer0to1Accounts)
      .instruction();

    txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      manage0to1Ix,
      [strategist]
    );
    ths.expectTxToSucceed(txResult.result);

    const finalBalance0 = await client.getBalance(boringVaultAccount);
    const finalBalance1 = await client.getBalance(boringVaultSubAccount1);

    expect(Number(finalBalance0)).to.equal(
      Number(initialBalance0) - transferAmount.toNumber()
    );
    expect(Number(finalBalance1)).to.equal(
      Number(initialBalance1) + transferAmount.toNumber()
    );

    // Execute transfer back from 1->0
    const initialBalance0ForReturn = await client.getBalance(
      boringVaultAccount
    );
    const initialBalance1ForReturn = await client.getBalance(
      boringVaultSubAccount1
    );

    const manage1to0Ix = await program.methods
      .manage(
        // @ts-ignore
        {
          vaultId: new anchor.BN(0),
          subAccount: 1, // Using sub-account 1
          ixProgramId: anchor.web3.SystemProgram.programId,
          ixData: transfer1to0IxData,
          operators: CpiService.getWSolTransferOperators(),
          expectedSize: 104,
        }
      )
      .accounts({
        signer: strategist.publicKey,
        boringVaultState: boringVaultStateAccount,
        boringVault: boringVaultSubAccount1, // Using sub-account 1
        cpiDigest: cpiDigest1to0Account,
      })
      .remainingAccounts(transfer1to0Accounts)
      .instruction();

    txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      manage1to0Ix,
      [strategist]
    );
    ths.expectTxToSucceed(txResult.result);

    const finalBalance0ForReturn = await client.getBalance(boringVaultAccount);
    const finalBalance1ForReturn = await client.getBalance(
      boringVaultSubAccount1
    );

    expect(Number(finalBalance0ForReturn)).to.equal(
      Number(initialBalance0ForReturn) + transferAmount.toNumber()
    );
    expect(Number(finalBalance1ForReturn)).to.equal(
      Number(initialBalance1ForReturn) - transferAmount.toNumber()
    );
  });
});
