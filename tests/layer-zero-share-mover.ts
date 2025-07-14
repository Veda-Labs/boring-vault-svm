import * as anchor from "@coral-xyz/anchor";
import { BankrunProvider, startAnchor } from "anchor-bankrun";
import { ProgramTestContext, BanksClient } from "solana-bankrun";
import { expect } from "chai";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { BN } from "bn.js";
import * as fs from "fs";
import {
  createStubTokenMint,
  fundAccount,
  LZ_RECEIVE_TYPES_SEED,
  OAPP_SEED,
  PEER_SEED,
  PROGRAM_CONFIG_SEED,
  SHARE_MOVER_SEED,
} from "./utils";
import { LayerZeroShareMover } from "../target/types/layer_zero_share_mover";
import { Endpoint } from "../target/types/endpoint";

const L0_ENDPOINT_ID = new anchor.web3.PublicKey(
  "5hkWNgGVXnwofEjDNtY5u3WUCvUUxXES5wyG4V3aEo1F"
);

describe("layer-zero-share-mover <> endpoint integration", () => {
  let provider: BankrunProvider;
  let context: ProgramTestContext;
  let client: BanksClient;
  let smProgram: anchor.Program<LayerZeroShareMover>;
  let epProgram: anchor.Program<Endpoint>;
  let admin: anchor.web3.Keypair;
  let configPda: anchor.web3.PublicKey;
  let shareMover: anchor.web3.PublicKey;

  before(async () => {
    context = await startAnchor(
      "",
      [
        {
          name: "endpoint",
          programId: L0_ENDPOINT_ID,
        },
      ],
      []
    );

    provider = new BankrunProvider(context);
    client = context.banksClient;
    anchor.setProvider(provider as unknown as anchor.Provider);

    smProgram = anchor.workspace
      .LayerZeroShareMover as anchor.Program<LayerZeroShareMover>;
    epProgram = anchor.workspace.Endpoint as anchor.Program<Endpoint>;

    admin = anchor.web3.Keypair.generate();

    await fundAccount(context, admin, 2_000_000_000);
  });

  it("creates program config", async () => {
    const programKeypair = anchor.web3.Keypair.fromSecretKey(
      new Uint8Array(
        JSON.parse(
          fs.readFileSync(
            "target/deploy/layer_zero_share_mover-keypair.json",
            "utf-8"
          )
        )
      )
    );

    const [cfg] = anchor.web3.PublicKey.findProgramAddressSync(
      [PROGRAM_CONFIG_SEED],
      smProgram.programId
    );

    await smProgram.methods
      .initialize(admin.publicKey)
      .accounts({
        signer: admin.publicKey,
      })
      .signers([admin, programKeypair])
      .rpc();

    configPda = cfg;

    const cfgData: any = await smProgram.account.programConfig.fetch(configPda);
    expect(cfgData.authority.toBase58()).to.equal(admin.publicKey.toBase58());
  });

  it("deploys a ShareMover and registers OApp via endpoint", async () => {
    const mint = anchor.web3.Keypair.generate();
    await context.setAccount(mint.publicKey, {
      lamports: 1_000_000_000,
      data: createStubTokenMint(admin.publicKey, 9),
      owner: TOKEN_2022_PROGRAM_ID,
      executable: false,
      rentEpoch: 0,
    });

    const [smPda, smBump] = anchor.web3.PublicKey.findProgramAddressSync(
      [SHARE_MOVER_SEED, mint.publicKey.toBuffer()],
      smProgram.programId
    );
    shareMover = smPda;
    const [lzTypesPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [LZ_RECEIVE_TYPES_SEED, shareMover.toBuffer()],
      smProgram.programId
    );
    const [oappRegistryPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [OAPP_SEED, shareMover.toBuffer()],
      L0_ENDPOINT_ID
    );

    await smProgram.methods
      .deploy({
        admin: admin.publicKey,
        executorProgram: anchor.web3.PublicKey.default,
        boringVaultProgram: anchor.web3.PublicKey.default,
        vaultId: new BN(0),
        subAccount: 0,
        peerDecimals: 9,
        outboundLimit: new BN(0),
        outboundWindow: new BN(0),
        inboundLimit: new BN(0),
        inboundWindow: new BN(0),
        peerChain: { unknown: {} },
      })
      .accounts({
        signer: admin.publicKey,
        mint: mint.publicKey,
        oappRegistry: oappRegistryPda,
        endpointProgram: L0_ENDPOINT_ID,
      })
      .signers([admin])
      .rpc();

    const sm: any = await smProgram.account.shareMover.fetch(shareMover);
    expect(sm.admin.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(sm.mint.toBase58()).to.equal(mint.publicKey.toBase58());
    expect(sm.bump).to.equal(smBump);

    expect(sm.endpointProgram.toBase58()).to.equal(L0_ENDPOINT_ID.toBase58());

    expect(sm.executorProgram.toBase58()).to.equal(
      anchor.web3.PublicKey.default.toBase58()
    );
    expect(sm.boringVaultProgram.toBase58()).to.equal(
      anchor.web3.PublicKey.default.toBase58()
    );

    const [expectedVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("boring_vault"),
        new BN(0).toArrayLike(Buffer, "le", 8),
        Buffer.from([0]),
      ],
      anchor.web3.PublicKey.default
    );
    expect(sm.vault.toBase58()).to.equal(expectedVaultPda.toBase58());

    const isPaused = sm.isPaused ?? sm.is_paused;
    expect(isPaused).to.be.false;
    const allowFrom = sm.allowFrom ?? sm.allow_from;
    const allowTo = sm.allowTo ?? sm.allow_to;
    expect(allowFrom).to.be.false;
    expect(allowTo).to.be.false;

    const peerDecimals = sm.peerDecimals ?? sm.peer_decimals;
    expect(peerDecimals).to.equal(9);

    const lzTypes: any = await smProgram.account.lzReceiveTypesAccounts.fetch(
      lzTypesPda
    );
    expect(lzTypes).to.exist;
    if (lzTypes.store) {
      expect(lzTypes.store.toBase58()).to.equal(shareMover.toBase58());
    }

    const registry: any = await epProgram.account.oAppRegistry.fetch(
      oappRegistryPda
    );
    expect(registry.delegate.toBase58()).to.equal(admin.publicKey.toBase58());
  });

  it("sets allow flags successfully", async () => {
    await smProgram.methods
      .setAllow(true, true)
      // @ts-ignore
      .accounts({ signer: admin.publicKey, shareMover })
      .signers([admin])
      .rpc();

    const sm: any = await smProgram.account.shareMover.fetch(shareMover);
    expect(sm.allowFrom).to.be.true;
    expect(sm.allowTo).to.be.true;
  });

  it("fails to set allow flags if signer is not admin", async () => {
    const badActor = anchor.web3.Keypair.generate();
    await fundAccount(context, badActor, 1_000_000_000);

    await smProgram.methods
      .setAllow(false, false)
      // @ts-ignore
      .accounts({ signer: badActor.publicKey, shareMover })
      .signers([badActor])
      .rpc()
      .catch((e) => {
        expect(String(e)).to.include("Not authorized");
      });
  });

  it("pauses and unpauses successfully", async () => {
    await smProgram.methods
      .setPause(true)
      // @ts-ignore
      .accounts({ signer: admin.publicKey, shareMover })
      .signers([admin])
      .rpc();
    let sm: any = await smProgram.account.shareMover.fetch(shareMover);
    expect(sm.isPaused).to.be.true;

    await smProgram.methods
      .setPause(false)
      // @ts-ignore
      .accounts({ signer: admin.publicKey, shareMover })
      .signers([admin])
      .rpc();
    sm = await smProgram.account.shareMover.fetch(shareMover);
    expect(sm.isPaused).to.be.false;
  });

  it("fails to set pause state if signer is not admin", async () => {
    const outsider = anchor.web3.Keypair.generate();
    await fundAccount(context, outsider, 1_000_000_000);

    await smProgram.methods
      .setPause(true)
      // @ts-ignore
      .accounts({ signer: outsider.publicKey, shareMover })
      .signers([outsider])
      .rpc()
      .catch((e) => {
        expect(String(e)).to.include("Not authorized");
      });
  });

  it("sets endpoint program successfully", async () => {
    const newEndpoint = anchor.web3.Keypair.generate().publicKey;

    await smProgram.methods
      .setEndpointProgram(newEndpoint)
      // @ts-ignore
      .accounts({ signer: admin.publicKey, shareMover })
      .signers([admin])
      .rpc();

    let sm: any = await smProgram.account.shareMover.fetch(shareMover);
    expect(sm.endpointProgram.toBase58()).to.equal(newEndpoint.toBase58());
  });

  it("fails to set endpoint program if signer is not admin", async () => {
    const outsider = anchor.web3.Keypair.generate();
    await fundAccount(context, outsider, 1_000_000_000);

    await smProgram.methods
      .setEndpointProgram(anchor.web3.PublicKey.default)
      // @ts-ignore
      .accounts({ signer: outsider.publicKey, shareMover })
      .signers([outsider])
      .rpc()
      .catch((e) => {
        expect(String(e)).to.include("Not authorized");
      });
  });

  it("sets executor program successfully", async () => {
    const newExec = anchor.web3.Keypair.generate().publicKey;

    await smProgram.methods
      .setExecutorProgram(newExec)
      // @ts-ignore
      .accounts({ signer: admin.publicKey, shareMover })
      .signers([admin])
      .rpc();

    let sm: any = await smProgram.account.shareMover.fetch(shareMover);
    expect(sm.executorProgram.toBase58()).to.equal(newExec.toBase58());
  });

  it("fails to set executor program if signer is not admin", async () => {
    const bad = anchor.web3.Keypair.generate();
    await fundAccount(context, bad, 1_000_000_000);

    await smProgram.methods
      .setExecutorProgram(anchor.web3.PublicKey.default)
      // @ts-ignore
      .accounts({ signer: bad.publicKey, shareMover })
      .signers([bad])
      .rpc()
      .catch((e) => {
        expect(String(e)).to.include("Not authorized");
      });
  });

  it("sets peer successfully and fails when paused", async () => {
    const remoteEid = 101;
    const peerAddress = new Uint8Array(32);
    peerAddress.set([1, 2, 3]);

    const [peerPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        PEER_SEED,
        shareMover.toBuffer(),
        new Uint8Array(new BN(remoteEid).toArray("be", 4)),
      ],
      smProgram.programId
    );

    await smProgram.methods
      .setPeer({ remoteEid, peerAddress: [...peerAddress] })
      .accounts({
        signer: admin.publicKey,
        // @ts-ignore
        shareMover,
        peer: peerPda,
      })
      .signers([admin])
      .rpc();

    let peer: any = await smProgram.account.peerConfig.fetch(peerPda);
    expect(Buffer.from(peer.peerAddress)).to.deep.equal(peerAddress);
  });

  it("fails to set peer when address is all zeros", async () => {
    const remoteEid = 505;
    const zeroAddr = new Uint8Array(32);

    const [peerPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        PEER_SEED,
        shareMover.toBuffer(),
        new Uint8Array(new BN(remoteEid).toArray("be", 4)),
      ],
      smProgram.programId
    );

    await smProgram.methods
      .setPeer({ remoteEid, peerAddress: [...zeroAddr] })
      // @ts-ignore
      .accounts({ signer: admin.publicKey, shareMover, peer: peerPda })
      .signers([admin])
      .rpc()
      .catch((e) => {
        expect(String(e)).to.include("Invalid peer address");
      });
  });

  it("closes peer successfully", async () => {
    const remoteEid = 202;
    const addr = new Uint8Array(32);
    addr.set([9, 9, 9]);

    const [peerPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        PEER_SEED,
        shareMover.toBuffer(),
        new Uint8Array(new BN(remoteEid).toArray("be", 4)),
      ],
      smProgram.programId
    );

    // ensure peer exists
    await smProgram.methods
      .setPeer({ remoteEid, peerAddress: [...addr] })
      .accounts({
        signer: admin.publicKey,
        // @ts-ignore
        shareMover,
        peer: peerPda,
      })
      .signers([admin])
      .rpc();

    // close
    await smProgram.methods
      .closePeer(remoteEid)
      .accounts({
        signer: admin.publicKey,
        // @ts-ignore
        shareMover,
        peer: peerPda,
      })
      .signers([admin])
      .rpc();

    const peerAccount = await client.getAccount(peerPda);
    expect(peerAccount).to.be.null;
  });

  it("fails to close peer if signer is not admin", async () => {
    const remoteEid = 303;
    const addr = new Uint8Array(32);
    addr.set([1, 2, 3]);
    const [peerPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        PEER_SEED,
        shareMover.toBuffer(),
        new Uint8Array(new BN(remoteEid).toArray("be", 4)),
      ],
      smProgram.programId
    );

    // create peer
    await smProgram.methods
      .setPeer({ remoteEid, peerAddress: [...addr] })
      .accounts({
        signer: admin.publicKey,
        // @ts-ignore
        shareMover,
        peer: peerPda,
      })
      .signers([admin])
      .rpc();

    const outsider = anchor.web3.Keypair.generate();
    await fundAccount(context, outsider, 1_000_000_000);

    await smProgram.methods
      .closePeer(remoteEid)
      .accounts({
        signer: outsider.publicKey,
        // @ts-ignore
        shareMover,
        peer: peerPda,
      })
      .signers([outsider])
      .rpc()
      .catch((e) => {
        expect(String(e)).to.include("Not authorized");
      });
  });

  it("fails to close peer when ShareMover is paused", async () => {
    const remoteEid = 404;
    const addr = new Uint8Array(32);
    addr.set([1, 2, 3]);

    const [peerPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        PEER_SEED,
        shareMover.toBuffer(),
        new Uint8Array(new BN(remoteEid).toArray("be", 4)),
      ],
      smProgram.programId
    );

    // create peer
    await smProgram.methods
      .setPeer({ remoteEid, peerAddress: [...addr] })
      .accounts({
        signer: admin.publicKey,
        // @ts-ignore
        shareMover,
        peer: peerPda,
      })
      .signers([admin])
      .rpc();

    // pause ShareMover
    await smProgram.methods
      .setPause(true)
      // @ts-ignore
      .accounts({ signer: admin.publicKey, shareMover })
      .signers([admin])
      .rpc();

    await smProgram.methods
      .closePeer(remoteEid)
      .accounts({
        signer: admin.publicKey,
        // @ts-ignore
        shareMover,
        peer: peerPda,
      })
      .signers([admin])
      .rpc()
      .catch((e) => {
        expect(e.error.errorMessage).to.include("Vault paused");
      });

    // unpause for subsequent tests
    await smProgram.methods
      .setPause(false)
      // @ts-ignore
      .accounts({ signer: admin.publicKey, shareMover: shareMover })
      .signers([admin])
      .rpc();
  });

  it("allows changing endpoint program while paused", async () => {
    await smProgram.methods
      .setPause(true)
      // @ts-ignore
      .accounts({ signer: admin.publicKey, shareMover })
      .signers([admin])
      .rpc();

    const newEndpoint = anchor.web3.Keypair.generate().publicKey;
    await smProgram.methods
      .setEndpointProgram(newEndpoint)
      // @ts-ignore
      .accounts({ signer: admin.publicKey, shareMover: shareMover })
      .signers([admin])
      .rpc();

    const sm: any = await smProgram.account.shareMover.fetch(shareMover);
    expect(sm.endpointProgram.toBase58()).to.equal(newEndpoint.toBase58());

    // unpause
    await smProgram.methods
      .setPause(false)
      // @ts-ignore
      .accounts({ signer: admin.publicKey, shareMover })
      .signers([admin])
      .rpc();
  });

  it("allows changing executor program while paused", async () => {
    await smProgram.methods
      .setPause(true)
      // @ts-ignore
      .accounts({ signer: admin.publicKey, shareMover })
      .signers([admin])
      .rpc();

    const newExec = anchor.web3.Keypair.generate().publicKey;
    await smProgram.methods
      .setExecutorProgram(newExec)
      // @ts-ignore
      .accounts({ signer: admin.publicKey, shareMover })
      .signers([admin])
      .rpc();

    const sm: any = await smProgram.account.shareMover.fetch(shareMover);
    expect(sm.executorProgram.toBase58()).to.equal(newExec.toBase58());

    await smProgram.methods
      .setPause(false)
      // @ts-ignore
      .accounts({ signer: admin.publicKey, shareMover })
      .signers([admin])
      .rpc();
  });

  it("fails to transfer authority to zero pubkey", async () => {
    await smProgram.methods
      .transferAuthority(anchor.web3.PublicKey.default)
      // @ts-ignore
      .accounts({ signer: admin.publicKey, shareMover })
      .signers([admin])
      .rpc()
      .catch((e) => {
        expect(String(e)).to.include("Invalid new admin");
      });
  });

  it("sets rate limits successfully", async () => {
    await smProgram.methods
      .setRateLimit(new BN(1000), new BN(3600), new BN(500), new BN(3600))
      // @ts-ignore
      .accounts({ signer: admin.publicKey, shareMover })
      .signers([admin])
      .rpc();

    let sm: any = await smProgram.account.shareMover.fetch(shareMover);
    expect(sm.outboundRateLimit.limit.toNumber()).to.equal(1000);
    expect(sm.outboundRateLimit.window.toNumber()).to.equal(3600);
    expect(sm.inboundRateLimit.limit.toNumber()).to.equal(500);
    expect(sm.inboundRateLimit.window.toNumber()).to.equal(3600);
  });

  it("fails to set rate limits if signer is not admin", async () => {
    const outsider = anchor.web3.Keypair.generate();
    await fundAccount(context, outsider, 1_000_000_000);

    await smProgram.methods
      .setRateLimit(new BN(1), new BN(1), new BN(1), new BN(1))
      // @ts-ignore
      .accounts({ signer: outsider.publicKey, shareMover: shareMover })
      .signers([outsider])
      .rpc()
      .catch((e) => {
        expect(String(e)).to.include("Not authorized");
      });
  });

  it("transfers authority successfully", async () => {
    const newAdmin = anchor.web3.Keypair.generate();
    await fundAccount(context, newAdmin, 1_000_000_000);

    await smProgram.methods
      .transferAuthority(newAdmin.publicKey)
      // @ts-ignore
      .accounts({ signer: admin.publicKey, shareMover })
      .signers([admin])
      .rpc();

    let sm: any = await smProgram.account.shareMover.fetch(shareMover);
    expect(sm.admin.toBase58()).to.equal(newAdmin.publicKey.toBase58());
  });

  it("prevents old admin actions after authority transfer", async () => {
    await smProgram.methods
      .setPause(true)
      // @ts-ignore
      .accounts({ signer: admin.publicKey, shareMover })
      .signers([admin])
      .rpc()
      .catch((e) => {
        expect(String(e)).to.include("Not authorized");
      });
  });
});
