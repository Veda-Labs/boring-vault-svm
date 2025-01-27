import * as anchor from "@coral-xyz/anchor";
import { BankrunProvider, startAnchor } from "anchor-bankrun";
import { Program } from "@coral-xyz/anchor";
import { BoringVaultSvm } from "../target/types/boring_vault_svm";
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

describe("boring-vault-svm", () => {
  let provider: BankrunProvider;
  let program: Program<BoringVaultSvm>;
  let context: ProgramTestContext;
  let client: BanksClient;
  let connection: Connection;

  let deployer: anchor.web3.Keypair;
  let authority: anchor.web3.Keypair = anchor.web3.Keypair.generate();
  let user: anchor.web3.Keypair = anchor.web3.Keypair.generate();

  let programConfigAccount: anchor.web3.PublicKey;
  let boringVaultStateAccount: anchor.web3.PublicKey;
  let boringVaultAccount: anchor.web3.PublicKey;
  let boringVaultShareMint: anchor.web3.PublicKey;
  let userJitoSolAta: anchor.web3.PublicKey;
  let vaultJitoSolAta: anchor.web3.PublicKey;
  let jitoSolAssetDataPda: anchor.web3.PublicKey;
  let solAssetDataPda: anchor.web3.PublicKey;
  let userShareAta: anchor.web3.PublicKey;
  let vaultWSolAta: anchor.web3.PublicKey;

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
        units: 400_000,
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

  // Helper function to get token balance from bankrun
  async function getTokenBalance(
    client: BanksClient,
    tokenAccount: PublicKey
  ): Promise<bigint> {
    const account = await client.getAccount(tokenAccount);
    if (!account) throw new Error("Account not found");

    return AccountLayout.decode(account.data).amount;
  }

  before(async () => {
    connection = new Connection("https://api.mainnet-beta.solana.com");

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
        address: user.publicKey,
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
        Buffer.from(new Array(8).fill(0))
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

    let dev = new anchor.web3.PublicKey("DuheUFDBEGh1xKKvCvcTPQwA8eR3oo58kzVpB54TW5TP");
    let devWSolAta: anchor.web3.PublicKey;
    devWSolAta = await setupATA(context, TOKEN_PROGRAM_ID, WSOL, dev, 0);

    console.log("devWSolAta: ", devWSolAta.toString());


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
        strategist: user.publicKey,
        name: "Boring Vault",
        symbol: "Boring Vault",
        decimals: 9
      }
    )
    .accounts({
      // @ts-ignore
      config: programConfigAccount,
      boringVaultState: boringVaultStateAccount,
      boringVault: boringVaultAccount,
      shareMint: boringVaultShareMint,
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

  it("Can update asset data", async () => {
    const ix = await program.methods
    .updateAssetData(
      {
        vaultId: new anchor.BN(0),
        assetData: {
          allowDeposits: true,
          allowWithdrawals: true,
          sharePremiumBps: 100,
          priceFeed: JITOSOL_SOL_ORACLE,
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
    expect(assetData.priceFeed.equals(JITOSOL_SOL_ORACLE)).to.be.true;
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
    expect((userShareEndBalance - userShareStartBalance).toString()).to.equal("1000000000");
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
          priceFeed: JITOSOL_SOL_ORACLE,
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
      priceFeed: JITOSOL_SOL_ORACLE,
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
    expect(BigInt(userShareEndBalance - userShareStartBalance) > BigInt(1171923747)); // Should mint more than 1 share since JitoSol is more valuable than a share.
    expect((userJitoSolStartBalance - userJitoSolEndBalance).toString()).to.equal(depositAmount.toString());
    expect((vaultJitoSolEndBalance - vaultJitoSolStartBalance).toString()).to.equal(depositAmount.toString());
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

    // Advance to slot 3 to ensure the lookup table is warm.
    context.warpToSlot(BigInt(2));

    // Step 1: Call Init User Metadata on Kamino Lend Program.
    const discriminator = Buffer.from("75a9b045c5170fa2", "hex");
    const initUserMetadataIx = Buffer.concat([discriminator, lookupTableAddress.toBuffer()]);

    // for debugging
    // console.log("init user metadata ix", initUserMetadataIx.toString("hex"));
    // let exampleLookupTableAddress = new anchor.web3.PublicKey("8xzmgxayzKLzEVQYti1rZpE5Bwad9dURmtGytfhbzkEe");
    // const exampleIx = Buffer.concat([discriminator, exampleLookupTableAddress.toBuffer()]);
    // console.log("example ix", exampleIx.toString("hex"));

    // 2. Find CPI Digest Account
    const [userMetadataPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("user_metadata"), // from https://github.com/Kamino-Finance/klend/blob/master/programs/klend/src/utils/seeds.rs#L7
        boringVaultAccount.toBuffer(),
      ],
      KAMINO_LEND_PROGRAM_ID
    );
    const initUserMetadataAccounts = [
      { pubkey: boringVaultAccount, isWritable: false, isSigner: false },
      { pubkey: boringVaultAccount, isWritable: true, isSigner: false },
      { pubkey: userMetadataPda, isWritable: true, isSigner: false },
      { pubkey: KAMINO_LEND_PROGRAM_ID, isWritable: false, isSigner: false },
      { pubkey: anchor.web3.SYSVAR_RENT_PUBKEY, isWritable: false, isSigner: false },
      { pubkey: anchor.web3.SystemProgram.programId, isWritable: false, isSigner: false },
      { pubkey: KAMINO_LEND_PROGRAM_ID, isWritable: false, isSigner: false },
    ];

    let txResult_1 = await CpiService.executeCpi(
      {
        program: program,
        client: client,
        deployer: deployer,
        authority: authority,
        vaultId: new anchor.BN(0),
        ixProgramId: KAMINO_LEND_PROGRAM_ID,
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
});
