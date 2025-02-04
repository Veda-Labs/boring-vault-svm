import * as anchor from "@coral-xyz/anchor";
import { BankrunProvider, startAnchor } from "anchor-bankrun";
import { Program } from "@coral-xyz/anchor";
import { BoringVaultSvm } from "../target/types/boring_vault_svm";
import { MockKaminoLend } from "../target/types/mock_kamino_lend";
import { BoringOnchainQueue } from "../target/types/boring_onchain_queue";
import { expect } from "chai";
import { ComputeBudgetProgram, AddressLookupTableProgram } from "@solana/web3.js";
import {
  ACCOUNT_SIZE,
  AccountLayout,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID
} from "@solana/spl-token";
import {
  Clock,
  AddedAccount,
  BanksClient,
  BanksTransactionResultWithMeta,
  ProgramTestContext,
} from "solana-bankrun";
import {
  PublicKey,
  Transaction,
  Keypair,
  Connection,
  TransactionInstruction
} from "@solana/web3.js";
import { CpiService } from "./services";

import dotenv from 'dotenv';
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

  let programConfigAccount: anchor.web3.PublicKey;
  let boringVaultStateAccount: anchor.web3.PublicKey;
  let boringVaultAccount: anchor.web3.PublicKey;
  let boringVaultShareMint: anchor.web3.PublicKey;
  let userJitoSolAta: anchor.web3.PublicKey;
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
  const STAKE_POOL_PROGRAM_ID = new anchor.web3.PublicKey('SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy');
  const JITO_SOL_STAKE_POOL = new anchor.web3.PublicKey('Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb');
  const JITO_SOL_STAKE_POOL_WITHDRAW_AUTH = new anchor.web3.PublicKey('6iQKfEyhr3bZMotVkW6beNZz5CPAkiwvgV2CTje9pVSS');
  const JITO_SOL_STAKE_POOL_RESERVE = new anchor.web3.PublicKey('BgKUXdS29YcHCFrPm5M8oLHiTzZaMDjsebggjoaQ6KFL');
  const JITO_SOL_STAKE_POOL_FEE = new anchor.web3.PublicKey('feeeFLLsam6xZJFc6UQFrHqkvVt4jfmVvi2BRLkUZ4i');

  const JITOSOL_SOL_ORACLE = new anchor.web3.PublicKey('4Z1SLH9g4ikNBV8uP2ZctEouqjYmVqB2Tz5SZxKYBN7z');
  const JITOSOL = new anchor.web3.PublicKey('J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn');

  const ADDRESS_LOOKUP_TABLE_PROGRAM_ID = new anchor.web3.PublicKey('AddressLookupTab1e1111111111111111111111111');

  const KAMINO_LEND_PROGRAM_ID = new anchor.web3.PublicKey('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');
  const KAMINO_LEND_JITO_SOL_OBLIGATION = new anchor.web3.PublicKey('95XivWGu4By7b7B6upK5ThXrYSsKKtNGrcpcgucTStNU');
  const KAMINO_LEND_JITO_SOL_MARKET = new anchor.web3.PublicKey('7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF');

  const WSOL = new anchor.web3.PublicKey('So11111111111111111111111111111111111111112');

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

  async function createAndProcessTransaction(
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
        units: 1_400_000,
      })
    );
    tx.sign(payer, ...additionalSigners);
    return await client.tryProcessTransaction(tx);
  }

  async function setupATA(
    context: ProgramTestContext,
    programId: PublicKey,
    mintAccount: PublicKey,
    owner: PublicKey,
    amount: number
  ): Promise<PublicKey> {
    const tokenAccData = Buffer.alloc(ACCOUNT_SIZE);
    
    // Check if this is a wSOL account
    const isNative = mintAccount.equals(WSOL);
    const rentExempt = isNative ? BigInt(2039280) : BigInt(0); // Minimum rent exempt balance for native accounts
    
    AccountLayout.encode(
      {
        mint: mintAccount,
        owner,
        amount: BigInt(amount),
        delegateOption: 0,
        delegate: PublicKey.default,
        delegatedAmount: BigInt(0),
        state: 1,
        isNativeOption: isNative ? 1 : 0,
        isNative: isNative ? rentExempt : BigInt(0), // For native accounts, this holds the rent exempt amount
        closeAuthorityOption: 0,
        closeAuthority: PublicKey.default,
      },
      tokenAccData,
    );
  
    const ata = getAssociatedTokenAddressSync(mintAccount, owner, true, programId);
    const ataAccountInfo = {
      lamports: isNative ? Number(rentExempt) + amount : 1_000_000_000, // Add rent exempt balance for native accounts
      data: tokenAccData,
      owner: programId,
      executable: false,
    };
  
    context.setAccount(ata, ataAccountInfo);
    return ata;
  }

  async function wait(seconds: number) {
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

  // Helper function to get token balance from bankrun
  async function getTokenBalance(
    client: BanksClient,
    tokenAccount: PublicKey
  ): Promise<bigint> {
    const account = await client.getAccount(tokenAccount);
    if (!account) throw new Error("Account not found");

    return AccountLayout.decode(account.data).amount;
  }

  async function updateExchangeRateAndWait(
    program: Program<BoringVaultSvm>,
    client: BanksClient,
    vaultId: anchor.BN,
    newExchangeRate: anchor.BN,
    exchangeRateProvider: Keypair,
    waitTimeInSeconds: number = 86400 // 1 day default
  ): Promise<{ feesOwed: bigint, platformFees: bigint, performanceFees: bigint }> {
    // Update exchange rate
    const ix = await program.methods
      .updateExchangeRate(vaultId, newExchangeRate)
      .accounts({
        signer: exchangeRateProvider.publicKey,
        boringVaultState: boringVaultStateAccount,
        // @ts-ignore
        shareMint: boringVaultShareMint,
        clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
      })
      .instruction();
  
    const txResult = await createAndProcessTransaction(
      client, 
      deployer, 
      ix, 
      [exchangeRateProvider]
    );

    // Expect the tx to succeed.
    expect(txResult.result).to.be.null;
  
    // Wait specified time
    await wait(waitTimeInSeconds);

    // Get program logs
    const logs = txResult.meta?.logMessages || [];

    // Find the fee messages
    const platformFeeLog = logs.find(log => log.includes("Platform fees owed:"));
    const performanceFeeLog = logs.find(log => log.includes("Performance fees owed:"));

    // Extract the fee amounts (optional)
    const platformFees = platformFeeLog 
        ? BigInt(platformFeeLog.split("Program log: Platform fees owed: ")[1]) 
        : BigInt(0);
    const performanceFees = performanceFeeLog 
        ? BigInt(performanceFeeLog.split("Program log: Performance fees owed: ")[1]) 
        : BigInt(0);
    
    // Get updated vault state to return fees
    const vaultState = await program.account.boringVault.fetch(boringVaultStateAccount);
    
    return {
      feesOwed: BigInt(vaultState.teller.feesOwedInBaseAsset.toNumber()),
      platformFees: platformFees,
      performanceFees: performanceFees,
    };
  }

  before(async () => {
    connection = new Connection(`https://solana-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`);
    // connection = new Connection(`https://api.mainnet-beta.solana.com`);

    // Helper function to create AddedAccount from public key
    const createAddedAccount = async (pubkeyStr: string): Promise<AddedAccount> => {
      const pubkey = new PublicKey(pubkeyStr);
      const accountInfo = await connection.getAccountInfo(pubkey);
      if (!accountInfo) throw new Error(`Failed to fetch account ${pubkeyStr}`);
      return {
        address: pubkey,
        info: accountInfo
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
        }
      },
      {
        address: strategist.publicKey,
        info: {
          lamports: 2_000_000_000,
          data: Buffer.alloc(0),
          owner: anchor.web3.SystemProgram.programId,
          executable: false,
        }
      },
      {
        address: user.publicKey,
        info: {
          lamports: 100_000_000_000,
          data: Buffer.alloc(0),
          owner: anchor.web3.SystemProgram.programId,
          executable: false,
        }
      },
      {
        address: newAuthority.publicKey,
        info: {
          lamports: 100_000_000_000,
          data: Buffer.alloc(0),
          owner: anchor.web3.SystemProgram.programId,
          executable: false,
        }
      }
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
          programId: STAKE_POOL_PROGRAM_ID
        },
        {
          name: "kamino_lend",
          programId: KAMINO_LEND_PROGRAM_ID
        }
      ],
      allAccounts
    );
    client = context.banksClient;
    provider = new BankrunProvider(context);
    deployer = context.payer;
    anchor.setProvider(provider);

    program = anchor.workspace.BoringVaultSvm as Program<BoringVaultSvm>;
    mockKaminoLendProgram = anchor.workspace.MockKaminoLend as Program<MockKaminoLend>;
    queueProgram = anchor.workspace.BoringOnchainQueue as Program<BoringOnchainQueue>;
    // Find PDAs
    let bump;
    [programConfigAccount, bump] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("config")
      ],
      program.programId
    );

    [boringVaultStateAccount, bump] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("boring-vault-state"),
        Buffer.from(new Array(8).fill(0))
      ],
      program.programId
    );

    [boringVaultAccount, bump] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("boring-vault"),
        Buffer.from(new Array(8).fill(0)),
        Buffer.from([0])
      ],
      program.programId
    );

    
    [boringVaultShareMint, bump] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("share-token"),
        boringVaultStateAccount.toBuffer(),
      ],
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

    userJitoSolAta = await setupATA(context, TOKEN_PROGRAM_ID, JITOSOL, user.publicKey, 1000000000000000000);
    vaultJitoSolAta = await setupATA(context, TOKEN_PROGRAM_ID, JITOSOL, boringVaultAccount, 1000000000); // 1 JitoSOL
    userShareAta = await setupATA(context, TOKEN_2022_PROGRAM_ID, boringVaultShareMint, user.publicKey, 0);
    vaultWSolAta = await setupATA(context, TOKEN_PROGRAM_ID, WSOL, boringVaultAccount, 1000000000); // Start with 1 wSOL.
    
    // Queue PDAs
    [queueProgramConfigAccount, bump] = anchor.web3.PublicKey.findProgramAddressSync(
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
    
    [jitoSolWithdrawAssetData, bump] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("boring-queue-withdraw-asset-data"),
        JITOSOL.toBuffer(),
        Buffer.from(new Array(8).fill(0))],
        queueProgram.programId
      );
      
      [userWithdrawState, bump] = anchor.web3.PublicKey.findProgramAddressSync(
        [
          Buffer.from("boring-queue-user-withdraw-state"),
          user.publicKey.toBuffer()],
          queueProgram.programId
        );
        
        queueShareAta = await setupATA(context, TOKEN_2022_PROGRAM_ID, boringVaultShareMint, queueAccount, 0);
        queueJitoSolAta = await setupATA(context, TOKEN_PROGRAM_ID, JITOSOL, queueAccount, 0); 
        
      });
      
  it("Is initialized", async () => {
    const ix = await program.methods
    .initialize(
      authority.publicKey
    )
    .accounts({
      // @ts-ignore
      config: programConfigAccount,
      signer: deployer.publicKey,
    })
    .instruction();

    let txResult = await createAndProcessTransaction(client, deployer, ix, [deployer]);

    // Expect the tx to succeed.
    expect(txResult.result).to.be.null;

    const programConfig = await program.account.programConfig.fetch(programConfigAccount);
    expect(programConfig.authority.equals(authority.publicKey)).to.be.true;
    expect(programConfig.vaultCount.toNumber()).to.equal(0);
  });

  it("Can deploy a vault", async () => {
    const ix = await program.methods
    .deploy(
      {
        authority: authority.publicKey,
        name: "Boring Vault",
        symbol: "BV",
        exchangeRateProvider: strategist.publicKey,
        exchangeRate: new anchor.BN(1000000000),
        payoutAddress: strategist.publicKey,
        allowedExchangeRateChangeUpperBound: 10050,
        allowedExchangeRateChangeLowerBound: 9950,
        minimumUpdateDelayInSeconds: 3600,
        platformFeeBps: 100,
        performanceFeeBps: 2000,
        strategist: strategist.publicKey,
        withdrawAuthority: anchor.web3.PublicKey.default // permissionless
      }
    )
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

    let txResult = await createAndProcessTransaction(client, deployer, ix, [authority]);

    // Expect the tx to succeed.
    expect(txResult.result).to.be.null;

    const programConfig = await program.account.programConfig.fetch(programConfigAccount);
    expect(programConfig.vaultCount.toNumber()).to.equal(1);

    const boringVault = await program.account.boringVault.fetch(boringVaultStateAccount);
    expect(boringVault.config.vaultId.toNumber()).to.equal(0);
    expect(boringVault.config.authority.equals(authority.publicKey)).to.be.true;
    expect(boringVault.config.shareMint.equals(boringVaultShareMint)).to.be.true;
    expect(boringVault.config.paused).to.be.false;
    expect(boringVault.config.initialized).to.be.true;

  });

  it("Can transfer authority", async () => {
    // Transfer authority to new authority.
    {
      const ix = await program.methods
      .transferAuthority(
           new anchor.BN(0),
           newAuthority.publicKey,
      )
      .accounts({
        signer: authority.publicKey,
        boringVaultState: boringVaultStateAccount,
      })
      .instruction();
  
      let txResult = await createAndProcessTransaction(client, deployer, ix, [authority]);
  
      // Expect the tx to succeed.
      expect(txResult.result).to.be.null;
  
      const boringVault = await program.account.boringVault.fetch(boringVaultStateAccount);
      expect(boringVault.config.pendingAuthority.equals(newAuthority.publicKey)).to.be.true;
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
  
      let txResult = await createAndProcessTransaction(client, deployer, ix, [newAuthority]);
  
      // Expect the tx to succeed.
      expect(txResult.result).to.be.null;

      const boringVault = await program.account.boringVault.fetch(boringVaultStateAccount);
      expect(boringVault.config.authority.equals(newAuthority.publicKey)).to.be.true;
      expect(boringVault.config.pendingAuthority.equals(anchor.web3.PublicKey.default)).to.be.true;
    }

    // Transfer authority back to original authority.
    {
      const ix = await program.methods
      .transferAuthority(
           new anchor.BN(0),
           authority.publicKey,
      )
      .accounts({
        signer: newAuthority.publicKey,
        boringVaultState: boringVaultStateAccount,
      })
      .instruction();
  
      let txResult = await createAndProcessTransaction(client, deployer, ix, [newAuthority]);
  
      // Expect the tx to succeed.
      expect(txResult.result).to.be.null;
  
      const boringVault = await program.account.boringVault.fetch(boringVaultStateAccount);
      expect(boringVault.config.pendingAuthority.equals(authority.publicKey)).to.be.true;
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
  
      let txResult = await createAndProcessTransaction(client, deployer, acceptIx, [authority]);
  
      // Expect the tx to succeed.
      expect(txResult.result).to.be.null;

      const boringVault = await program.account.boringVault.fetch(boringVaultStateAccount);
      expect(boringVault.config.authority.equals(authority.publicKey)).to.be.true;
      expect(boringVault.config.pendingAuthority.equals(anchor.web3.PublicKey.default)).to.be.true;
    }
  });

  it("Can update asset data", async () => {
    const ix = await program.methods
    .updateAssetData(
      {
        vaultId: new anchor.BN(0),
        assetData: {
          allowDeposits: true,
          allowWithdrawals: true,
          sharePremiumBps: 100,
          isPeggedToBaseAsset: true,
          priceFeed: anchor.web3.PublicKey.default,
          inversePriceFeed: false,
        }
      }
    )
    .accounts({
      signer: authority.publicKey,
      boringVaultState: boringVaultStateAccount,
      // @ts-ignore
      systemProgram: anchor.web3.SystemProgram.programId,
      asset: JITOSOL,
      assetData: jitoSolAssetDataPda,
    })
    .instruction();

    let txResult = await createAndProcessTransaction(client, deployer, ix, [authority]);

    // Expect the tx to succeed.
    expect(txResult.result).to.be.null;

    const assetData = await program.account.assetData.fetch(jitoSolAssetDataPda);
    expect(assetData.allowDeposits).to.be.true;
    expect(assetData.allowWithdrawals).to.be.true;
    expect(assetData.sharePremiumBps).to.equal(100);
    expect(assetData.isPeggedToBaseAsset).to.be.true;
    expect(assetData.priceFeed.equals(anchor.web3.PublicKey.default)).to.be.true;
    expect(assetData.inversePriceFeed).to.be.false;
  });

  it("Can deposit SOL into a vault", async () => {
    const ix_0 = await program.methods
    .updateAssetData(
      {
        vaultId: new anchor.BN(0),
        assetData: {
          allowDeposits: true,
          allowWithdrawals: true,
          sharePremiumBps: 0,
          isPeggedToBaseAsset: false,
          priceFeed: JITOSOL_SOL_ORACLE,
          inversePriceFeed: true,
        }
      }
    )
    .accounts({
      signer: authority.publicKey,
      boringVaultState: boringVaultStateAccount,
      // @ts-ignore
      systemProgram: anchor.web3.SystemProgram.programId,
      asset: anchor.web3.PublicKey.default,
      assetData: solAssetDataPda,
    })
    .instruction();

    let txResult_0 = await createAndProcessTransaction(client, deployer, ix_0, [authority]);

    // Expect the tx to succeed.
    expect(txResult_0.result).to.be.null;

    let depositAmount = new anchor.BN(1000000000);
    const ix_1 = await program.methods
    .depositSol(
      {
        vaultId: new anchor.BN(0),
        depositAmount: depositAmount,
        minMintAmount: new anchor.BN(0),
      }
    )
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

    let userShareStartBalance = await getTokenBalance(client, userShareAta);
    let userSolStartBalance = await client.getBalance(user.publicKey);
    let txResult_1 = await createAndProcessTransaction(client, deployer, ix_1, [user]);

    // Expect the tx to succeed.
    expect(txResult_1.result).to.be.null;

    let userShareEndBalance = await getTokenBalance(client, userShareAta);
    let userSolEndBalance = await client.getBalance(user.publicKey);
    expect(BigInt(userShareEndBalance - userShareStartBalance) > BigInt(0));
    expect(BigInt(userShareEndBalance - userShareStartBalance) < BigInt(1000000000));
    expect((userSolStartBalance - userSolEndBalance).toString()).to.equal(depositAmount.toString());
  });
  
  it("Can deposit JitoSOL into a vault", async () => {
    const ix_0 = await program.methods
    .updateAssetData(
      {
        vaultId: new anchor.BN(0),
        assetData: {
          allowDeposits: true,
          allowWithdrawals: true,
          sharePremiumBps: 0,
          isPeggedToBaseAsset: true,
          priceFeed: anchor.web3.PublicKey.default,
          inversePriceFeed: false,
        }
      }
    )
    .accounts({
      signer: authority.publicKey,
      boringVaultState: boringVaultStateAccount,
      // @ts-ignore
      systemProgram: anchor.web3.SystemProgram.programId,
      asset: JITOSOL,
      assetData: jitoSolAssetDataPda,
    })
    .instruction();

    let txResult_0 = await createAndProcessTransaction(client, deployer, ix_0, [authority]);

    // Expect the tx to succeed.
    expect(txResult_0.result).to.be.null;

    let depositAmount = new anchor.BN(1000000000);
    const ix_1 = await program.methods
    .deposit(
      {
        vaultId: new anchor.BN(0),
        depositAmount: depositAmount,
        minMintAmount: new anchor.BN(0),
      }
    )
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

    let userShareStartBalance = await getTokenBalance(client, userShareAta);
    let userJitoSolStartBalance = await getTokenBalance(client, userJitoSolAta);
    let vaultJitoSolStartBalance = await getTokenBalance(client, vaultJitoSolAta);

    let txResult_1 = await createAndProcessTransaction(client, deployer, ix_1, [user]);

    // Expect the tx to succeed.
    expect(txResult_1.result).to.be.null;

    // We expect this to be 1 share larger because of the previous deposit.
    let userShareEndBalance = await getTokenBalance(client, userShareAta);
    let userJitoSolEndBalance = await getTokenBalance(client, userJitoSolAta);
    let vaultJitoSolEndBalance = await getTokenBalance(client, vaultJitoSolAta);
    expect(BigInt(userShareEndBalance - userShareStartBalance) == BigInt(1000000000)); // Should mint 1 share since JitoSol is base
    expect((userJitoSolStartBalance - userJitoSolEndBalance).toString()).to.equal(depositAmount.toString());
    expect((vaultJitoSolEndBalance - vaultJitoSolStartBalance).toString()).to.equal(depositAmount.toString());
  });

  it("Can withdraw JitoSOL from the vault", async () => {
    let withdraw_amount = new anchor.BN(1_000_000_000);
    const withdraw_ix = await program.methods
    .withdraw(
      {
        vaultId: new anchor.BN(0),
        shareAmount: withdraw_amount,
        minAssetsAmount: new anchor.BN(0)
      }
    )
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

    let userShareStartBalance = await getTokenBalance(client, userShareAta);
    let userJitoSolStartBalance = await getTokenBalance(client, userJitoSolAta);
    let vaultJitoSolStartBalance = await getTokenBalance(client, vaultJitoSolAta);

    let txResult_1 = await createAndProcessTransaction(client, deployer, withdraw_ix, [user]);

    // Expect the tx to succeed.
    expect(txResult_1.result).to.be.null;

    let userShareEndBalance = await getTokenBalance(client, userShareAta);
    let userJitoSolEndBalance = await getTokenBalance(client, userJitoSolAta);
    let vaultJitoSolEndBalance = await getTokenBalance(client, vaultJitoSolAta);
    expect(BigInt(userShareStartBalance - userShareEndBalance) == BigInt(1000000000)); // Should burned 1 share since JitoSol is base
    expect((userJitoSolEndBalance - userJitoSolStartBalance).toString()).to.equal(withdraw_amount.toString());
    expect((vaultJitoSolStartBalance - vaultJitoSolEndBalance).toString()).to.equal(withdraw_amount.toString());
  })

  it("Can update exchange rate and calculate fees owed", async () => {
    await wait(86_400);

    // First update - all fees should be zero
    let res_0 = await updateExchangeRateAndWait(
      program,
      client,
      new anchor.BN(0),
      new anchor.BN(1000000000),
      strategist,
      86400,
    );

    expect(res_0.feesOwed).to.equal(BigInt(0));
    expect(res_0.platformFees).to.equal(BigInt(0));
    expect(res_0.performanceFees).to.equal(BigInt(0));

    // Second update - all fees should be non-zero
    let res_1 = await updateExchangeRateAndWait(
      program,
      client,
      new anchor.BN(0),
      new anchor.BN(1000500000),
      strategist,
      86400,
    );

    expect(res_1.feesOwed > BigInt(0));
    expect(res_1.platformFees > BigInt(0));
    expect(res_1.performanceFees > BigInt(0));
    // Verify fees owed equals sum of platform and performance fees
    expect(res_1.feesOwed - res_0.feesOwed).to.equal(res_1.platformFees + res_1.performanceFees);

    // Third update - only platform fees should increase
    let res_2 = await updateExchangeRateAndWait(
      program,
      client,
      new anchor.BN(0),
      new anchor.BN(1000300000),
      strategist,
      86400,
    );

    expect(res_2.feesOwed > res_1.feesOwed);
    expect(res_2.platformFees > BigInt(0));
    expect(res_2.performanceFees).to.equal(BigInt(0));
    // Verify fees owed increased only by platform fees
    expect(res_2.feesOwed - res_1.feesOwed).to.equal(res_2.platformFees);

    // Fourth update - only platform fees should increase
    let res_3 = await updateExchangeRateAndWait(
      program,
      client,
      new anchor.BN(0),
      new anchor.BN(1000400000),
      strategist,
      86400,
    );

    expect(res_3.feesOwed > res_2.feesOwed);
    expect(res_3.platformFees > BigInt(0));
    expect(res_3.performanceFees).to.equal(BigInt(0));
    // Verify fees owed increased only by platform fees
    expect(res_3.feesOwed - res_2.feesOwed).to.equal(res_3.platformFees);

    // Fifth update - both platform and performance fees should increase
    let res_4 = await updateExchangeRateAndWait(
      program,
      client,
      new anchor.BN(0),
      new anchor.BN(1000700000),
      strategist,
      86400,
    );

    expect(res_4.feesOwed > res_3.feesOwed);
    expect(res_4.platformFees > BigInt(0));
    expect(res_4.performanceFees > BigInt(0));
    // Verify fees owed equals sum of platform and performance fees
    expect(res_4.feesOwed - res_3.feesOwed).to.equal(res_4.platformFees + res_4.performanceFees);

    // Sixth update - change exchange rate to a ridiculous value
    let res_5 = await updateExchangeRateAndWait(
      program,
      client,
      new anchor.BN(0),
      new anchor.BN(2000000000),
      strategist,
      86400,
    );

    expect(res_5.feesOwed == res_4.feesOwed); // No fees should be owed since the exchange rate is too high, and we paused
    expect(res_5.platformFees == BigInt(0));
    expect(res_5.performanceFees == BigInt(0));

    let boringVaultState = await program.account.boringVault.fetch(boringVaultStateAccount);
    expect(boringVaultState.config.paused).to.be.true;

    // Unpause the vault
    const unpause_ix = await program.methods
    .unpause(new anchor.BN(0))
    .accounts({
      signer: authority.publicKey,
      boringVaultState: boringVaultStateAccount,
    })
    .instruction();

    let txResult_unpause = await createAndProcessTransaction(client, deployer, unpause_ix, [authority]);
    expect(txResult_unpause.result).to.be.null;

    boringVaultState = await program.account.boringVault.fetch(boringVaultStateAccount);
    expect(boringVaultState.config.paused).to.be.false;

    // Seventh update - change exchange rate to a ridiculous low value
    let res_6 = await updateExchangeRateAndWait(
      program,
      client,
      new anchor.BN(0),
      new anchor.BN(100000000),
      strategist,
      86400,
    );

    expect(res_6.feesOwed == res_5.feesOwed); // No fees should be owed since the exchange rate is too high, and we paused
    expect(res_6.platformFees == BigInt(0));
    expect(res_6.performanceFees == BigInt(0));

    boringVaultState = await program.account.boringVault.fetch(boringVaultStateAccount);
    expect(boringVaultState.config.paused).to.be.true;

    // Unpause the vault
    const unpause_ix_1 = await program.methods
    .unpause(new anchor.BN(0))
    .accounts({
      signer: authority.publicKey,
      boringVaultState: boringVaultStateAccount,
    })
    .instruction();

    let txResult_unpause_1 = await createAndProcessTransaction(client, deployer, unpause_ix, [authority]);
    expect(txResult_unpause_1.result).to.be.null;

    // 8th update - change exchange rate to a ridiculous low value
    let res_7 = await updateExchangeRateAndWait(
      program,
      client,
      new anchor.BN(0),
      new anchor.BN(1000000000),
      strategist,
      86400,
    );

    // Unpause the vault
    const unpause_ix_2 = await program.methods
    .unpause(new anchor.BN(0))
    .accounts({
      signer: authority.publicKey,
      boringVaultState: boringVaultStateAccount,
    })
    .instruction();

    let txResult_unpause_2 = await createAndProcessTransaction(client, deployer, unpause_ix, [authority]);
    expect(txResult_unpause_2.result).to.be.null;
  });

  it("Vault can deposit SOL into JitoSOL stake pool", async () => {

    // Transfer SOL from user to vault.
    const transferSolIx = anchor.web3.SystemProgram.transfer({
      fromPubkey: user.publicKey,
      toPubkey: boringVaultAccount,
      lamports: 100_000_000, // 0.1 SOL in lamports
    });

    let transferTxResult = await createAndProcessTransaction(
      client, 
      deployer, 
      transferSolIx, 
      [user] // user needs to sign since they're sending the SOL
    );

    // Expect the transfer to succeed
    expect(transferTxResult.result).to.be.null;

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

    expect(txResult_0.result).to.be.null;
  });

  it("Can transfer sol and wrap it", async () => {
    // Create the transfer instruction data
    const transferIxData = Buffer.from("02000000f01d1f0000000000", "hex");

    // Get the accounts needed for transfer
    const transferAccounts = [
      { pubkey: boringVaultAccount, isWritable: true, isSigner: false }, // from
      { pubkey: vaultWSolAta, isWritable: true, isSigner: false }, // to
      { pubkey: anchor.web3.SystemProgram.programId, isWritable: false, isSigner: false }, // system program
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

    expect(txResult_0.result).to.be.null;

    // Now that our wSOL ata has SOL, we can wrap it.
    // Create the transfer instruction data
    const wrapIxData = Buffer.from([17]); // 11 in hex

    // Get the accounts needed for transfer
    const wrapAccounts = [
      { pubkey: vaultWSolAta, isWritable: true, isSigner: false }, // vault wSOL ATA
      { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false }, // token program
    ];

    let vaultWSolStartBalance = await getTokenBalance(client, vaultWSolAta);

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

    expect(txResult_1.result).to.be.null;

    let vaultWSolEndBalance = await getTokenBalance(client, vaultWSolAta);
    expect((vaultWSolEndBalance - vaultWSolStartBalance).toString()).to.equal("2039280");
  });

  // TODO test where I transfer SOL to a different sub account and back

  it("I Can lend JitoSOL on Mock Kamino", async () => {
    // Create lookup table for user
    const [lookupTableInst, lookupTableAddress] =
    AddressLookupTableProgram.createLookupTable({
      authority: user.publicKey,
      payer:user.publicKey,
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
        { pubkey: anchor.web3.SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }, // rent
        { pubkey: anchor.web3.SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
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
    expect(result.result).to.be.null;

  });

  it("I Can lend JitoSOL on Real Kamino", async () => {
    // Create lookup table for user
    const [lookupTableInst, lookupTableAddress] =
    AddressLookupTableProgram.createLookupTable({
      authority: user.publicKey,
      payer:user.publicKey,
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

    // Create the instruction
    const initUserMetadataIx = new anchor.web3.TransactionInstruction({
      programId: targetProgramId,
      keys: [
        { pubkey: user.publicKey, isSigner: true, isWritable: true }, // owner
        { pubkey: user.publicKey, isSigner: true, isWritable: true }, // fee_payer
        { pubkey: userMetadataPda, isSigner: false, isWritable: true }, // user_metadata
        { pubkey: targetProgramId, isSigner: false, isWritable: false }, // referrer_user_metadata
        { pubkey: anchor.web3.SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }, // rent
        { pubkey: anchor.web3.SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
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
    expect(result.result).to.be.null;

  });

  it("Can lend JitoSOL on Kamino", async () => {
    // Example tx https://solscan.io/tx/2cUbGCXmzvtXfZmc1WYbypx4rJAamHcTLqJyswjnyFbHsmT3ToVDXxUVrcnCTYbH3HqWTWMhiJcJqbGaaG9nRzdA

    // Step 0: Call Create Lookup Table
    const [lookupTableInst, lookupTableAddress] =
    AddressLookupTableProgram.createLookupTable({
      authority: boringVaultAccount,
      payer:boringVaultAccount,
      recentSlot: 0, // Bankrun starts at slot 1, so use slot 0.
    });

    const createLookupTableAccounts = [
      { pubkey: lookupTableAddress, isWritable: true, isSigner: false },
      { pubkey: boringVaultAccount, isWritable: true, isSigner: false },
      { pubkey: boringVaultAccount, isWritable: true, isSigner: false },
      { pubkey: anchor.web3.SystemProgram.programId, isWritable: false, isSigner: false },
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

    expect(txResult_0.result).to.be.null;

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
    const initUserMetadataIx = Buffer.concat([discriminator, lookupTableAddress.toBuffer()]);

    const initUserMetadataAccounts = [
      { pubkey: boringVaultAccount, isWritable: true, isSigner: false },
      { pubkey: boringVaultAccount, isWritable: true, isSigner: false },
      { pubkey: userMetadataPda, isWritable: true, isSigner: false },
      { pubkey: targetProgramId, isWritable: false, isSigner: false },
      { pubkey: anchor.web3.SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: anchor.web3.SystemProgram.programId, isSigner: false, isWritable: false },
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
    expect(txResult_1.result).to.be.null;

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
      .initialize(
        deployer.publicKey,
      )
      .accounts({
        signer: deployer.publicKey,
        // @ts-ignore
        config: queueProgramConfigAccount,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .instruction();

    let txResult = await createAndProcessTransaction(client, deployer, ix, [deployer]);
    expect(txResult.result).to.be.null;

    const queueConfig = await queueProgram.account.programConfig.fetch(queueProgramConfigAccount);
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

    let txResult = await createAndProcessTransaction(client, deployer, ix, [deployer]);
    expect(txResult.result).to.be.null;

    const queueState = await queueProgram.account.queueState.fetch(queueStateAccount);
    expect(queueState.authority.equals(authority.publicKey)).to.be.true;
    expect(queueState.boringVaultProgram.equals(program.programId)).to.be.true;
    expect(queueState.vaultId.toNumber()).to.equal(0);
    expect(queueState.paused).to.be.false;
  });

  it("Can update withdraw assets", async () => {
    const ix = await queueProgram.methods
    .updateWithdrawAssetData(
      // @ts-ignore
      {
        vaultId: new anchor.BN(0),
        secondsToMaturity: new anchor.BN(86400),
        minimumSecondsToDeadline: new anchor.BN(2 * 86400),
        minimumDiscount: new anchor.BN(1),
        maximumDiscount: new anchor.BN(10),
        minimumShares: new anchor.BN(1000)
      }
    )
    .accounts({
      signer: authority.publicKey,
      queueState: queueStateAccount,
      withdrawMint: JITOSOL,
      withdrawAssetData: jitoSolWithdrawAssetData,
      // Looks like system program is included by default?
    })
    .instruction();

    let txResult = await createAndProcessTransaction(client, deployer, ix, [authority]);
    expect(txResult.result).to.be.null;

    const withdrawAssetData = await queueProgram.account.withdrawAssetData.fetch(jitoSolWithdrawAssetData);
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
      userWithdrawState: userWithdrawState
    })
    .instruction();

    let txResult = await createAndProcessTransaction(client, deployer, ix, [user]);
    expect(txResult.result).to.be.null;
  });

  it("Allows users to make withdraw requests", async () => {
    let bump;
    [userWithdrawRequest, bump] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("boring-queue-withdraw-request"),
        user.publicKey.toBuffer(),
        Buffer.from(new Array(8).fill(0))],
      queueProgram.programId
    );

    const ix_withdraw_request = await queueProgram.methods
    .requestWithdraw(
      // @ts-ignore
      {
        vaultId: new anchor.BN(0),
        shareAmount: new anchor.BN(1000000),
        discount: new anchor.BN(3),
        secondsToDeadline: new anchor.BN(3 * 86400)
      }
    )
    .accounts({
      signer: user.publicKey,
      queueState: queueStateAccount,
      withdrawMint: JITOSOL,
      withdrawAssetData: jitoSolWithdrawAssetData,
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

    let txResult = await createAndProcessTransaction(client, deployer, ix_withdraw_request, [user]);
    expect(txResult.result).to.be.null;
  });

  it("Allows requests to be solved", async () => {
    await wait(86_401);

    const solve_ix = await queueProgram.methods
    .fulfillWithdraw(
      new anchor.BN(0), // vault id 0
      new anchor.BN(0), // request id 0
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

    let userJitoSolStartBalance = await getTokenBalance(client, userJitoSolAta);
    let vaultJitoSolStartBalance = await getTokenBalance(client, vaultJitoSolAta);
    let queueJitoSolStartBalance = await getTokenBalance(client, queueJitoSolAta);

    let txResult = await createAndProcessTransaction(client, deployer, solve_ix, [user]);
    expect(txResult.result).to.be.null;

    let userJitoSolEndBalance = await getTokenBalance(client, userJitoSolAta);
    let vaultJitoSolEndBalance = await getTokenBalance(client, vaultJitoSolAta);
    let queueJitoSolEndBalance = await getTokenBalance(client, queueJitoSolAta);

    expect((userJitoSolEndBalance - userJitoSolStartBalance).toString()).to.equal("999700"); // User gained JitoSol
    expect((vaultJitoSolStartBalance - vaultJitoSolEndBalance).toString()).to.equal("999700"); // Vault lossed JitoSol
    expect((queueJitoSolStartBalance - queueJitoSolEndBalance).toString()).to.equal("0"); // Queue had no change

  });

  it("Allows users to cancel withdraw requests", async () => {
    let bump;
    [userWithdrawRequest, bump] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("boring-queue-withdraw-request"),
        user.publicKey.toBuffer(),
        Buffer.from([1,0,0,0,0,0,0,0])],
      queueProgram.programId
    );

    const ix_withdraw_request = await queueProgram.methods
    .requestWithdraw(
      // @ts-ignore
      {
        vaultId: new anchor.BN(0),
        shareAmount: new anchor.BN(1000000),
        discount: new anchor.BN(3),
        secondsToDeadline: new anchor.BN(3 * 86400)
      }
    )
    .accounts({
      signer: user.publicKey,
      queueState: queueStateAccount,
      withdrawMint: JITOSOL,
      withdrawAssetData: jitoSolWithdrawAssetData,
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

    let txResult = await createAndProcessTransaction(client, deployer, ix_withdraw_request, [user]);
    expect(txResult.result).to.be.null;

    // Now have user cancel their request.
    const cancel_ix = await queueProgram.methods
    .cancelWithdraw(new anchor.BN(0), new anchor.BN(1))
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
    })
    .instruction();

    let userShareStartBalance = await getTokenBalance(client, userShareAta);

    let cancelResult = await createAndProcessTransaction(client, deployer, cancel_ix, [user]);
    expect(cancelResult.result).to.be.null;

    let userShareEndBalance = await getTokenBalance(client, userShareAta);

    expect((userShareEndBalance - userShareStartBalance).toString()).to.equal("1000000"); // User gained Shares

  });

  // TODO This test is super buggy and sometimes leaves the vault in a paused state, which can cause other tests to fail.
  it("Can pause and unpause vault", async () => {
    // Check initial state
    let vaultState = await program.account.boringVault.fetch(boringVaultStateAccount);
    expect(vaultState.config.paused).to.be.false;

    // Pause the vault
    const pauseIx = await program.methods
      .pause(new anchor.BN(0))
      .accounts({
        signer: authority.publicKey,
        boringVaultState: boringVaultStateAccount,
      })
      .instruction();

    let pauseTxResult = await createAndProcessTransaction(client, deployer, pauseIx, [authority]);
    
    // Check transaction succeeded or was already processed
    expect(
      pauseTxResult.result === null || 
      pauseTxResult.result.toString().includes("This transaction has already been processed")
    ).to.be.true;

    // Verify vault is paused
    vaultState = await program.account.boringVault.fetch(boringVaultStateAccount);
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

    let txResult = await createAndProcessTransaction(client, deployer, updateRateIx, [strategist]);
    expect(txResult.result).to.not.be.null;  // Transaction should fail

    // Unpause the vault
    const unpauseIx = await program.methods
      .unpause(new anchor.BN(0))
      .accounts({
        signer: authority.publicKey,
        boringVaultState: boringVaultStateAccount,
      })
      .instruction();

    let unpauseTxResult = await createAndProcessTransaction(client, deployer, unpauseIx, [authority]);
    
    // Check transaction succeeded or was already processed
    expect(
      unpauseTxResult.result === null || 
      unpauseTxResult.result.toString().includes("This transaction has already been processed")
    ).to.be.true;

    // Verify vault is unpaused
    vaultState = await program.account.boringVault.fetch(boringVaultStateAccount);
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

    let updateTxResult = await createAndProcessTransaction(client, deployer, updateRateIx2, [strategist]);
    expect(
      updateTxResult.result === null || 
      updateTxResult.result.toString().includes("This transaction has already been processed")
    ).to.be.true;
  });
});
