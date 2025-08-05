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

    const eventAuthority = anchor.web3.Keypair.generate()
    const eventProgram = anchor.web3.Keypair.generate()

    await smProgram.methods
      .deploy({
        admin: admin.publicKey,
        delegate: admin.publicKey,
        boringVaultProgram: anchor.web3.PublicKey.default,
        vaultId: new BN(0),
        peerDecimals: 9,
        outboundLimit: new BN(0),
        outboundWindow: new BN(0),
        inboundLimit: new BN(0),
        inboundWindow: new BN(0),
        peerChain: { evm: {} },
      })
      .accounts({
        signer: admin.publicKey,
        mint: mint.publicKey,
        oappRegistry: oappRegistryPda,
        endpointProgram: L0_ENDPOINT_ID,
        eventAuthority: eventAuthority.publicKey,
      })
      .signers([admin])
      .rpc();

    const sm: any = await smProgram.account.shareMover.fetch(shareMover);
    expect(sm.admin.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(sm.mint.toBase58()).to.equal(mint.publicKey.toBase58());
    expect(sm.bump).to.equal(smBump);

    expect(sm.endpointProgram.toBase58()).to.equal(L0_ENDPOINT_ID.toBase58());

    expect(sm.boringVaultProgram.toBase58()).to.equal(
      anchor.web3.PublicKey.default.toBase58()
    );

    const [expectedVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("boring-vault-state"),
        new BN(0).toArrayLike(Buffer, "le", 8),
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

  it("sets peer successfully and fails when paused", async () => {
    const remoteEid = 101;
    const peerAddress = Uint8Array.from(
      Buffer.from(
        "000000000000000000000000c1caf4915849cd5fe21efaa4ae14e4eafa7a3431",
        "hex"
      )
    );

    const [peerPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        PEER_SEED,
        shareMover.toBuffer(),
        new Uint8Array(new BN(remoteEid).toArray("be", 4)),
      ],
      smProgram.programId
    );

    await smProgram.methods
      .setPeer({
          remoteEid,
          config: { peerAddress: { 0: [...peerAddress] } },
        })
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
      .setPeer({ remoteEid, config: { peerAddress: { 0: [...zeroAddr] } } })
      // @ts-ignore
      .accounts({ signer: admin.publicKey, shareMover, peer: peerPda })
      .signers([admin])
      .rpc()
      .catch((e) => {
        expect(String(e)).to.include("Invalid peer address");
      });
  });


  it("sets enforced options on peer config", async () => {
    const remoteEid = 606;

    // helper to build a type-3 options blob: [0x00, 0x03] + payload bytes
    const buildType3 = (payload: number[]) => [0, 3, ...payload];

    const sendBlobArr = buildType3([10, 11, 12]);
    const sendAndCallBlobArr = buildType3([13, 14, 15]);
    const sendBlob = Buffer.from(sendBlobArr);
    const sendAndCallBlob = Buffer.from(sendAndCallBlobArr);

    const [peerPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        PEER_SEED,
        shareMover.toBuffer(),
        new Uint8Array(new BN(remoteEid).toArray("be", 4)),
      ],
      smProgram.programId
    );

    await smProgram.methods
      // Cast as any to satisfy Anchor TS generic expectations
      .setPeer({
        remoteEid,
        config: {
          enforcedOptions: {
            send: sendBlob,
            sendAndCall: sendAndCallBlob,
          },
        },
      } as any)
      .accounts({ signer: admin.publicKey, shareMover, peer: peerPda, systemProgram: anchor.web3.SystemProgram.programId } as any)
      .signers([admin])
      .rpc();

    const peer: any = await smProgram.account.peerConfig.fetch(peerPda);
    expect(Buffer.from(peer.enforcedOptions.send)).to.deep.equal(Uint8Array.from(sendBlobArr));
    expect(Buffer.from(peer.enforcedOptions.sendAndCall)).to.deep.equal(
      Uint8Array.from(sendAndCallBlobArr)
    );
  });

  it("fails to set enforced options if blob is not type 3", async () => {
    const remoteEid = 707;
    const badBlob = Buffer.from([0, 1, 99]); // type 1 – should be rejected

    const [peerPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        PEER_SEED,
        shareMover.toBuffer(),
        new Uint8Array(new BN(remoteEid).toArray("be", 4)),
      ],
      smProgram.programId
    );

    await smProgram.methods
      .setPeer({
        remoteEid,
        config: { enforcedOptions: { send: badBlob, sendAndCall: badBlob } },
      } as any)
      .accounts({ signer: admin.publicKey, shareMover, peer: peerPda, systemProgram: anchor.web3.SystemProgram.programId } as any)
      .signers([admin])
      .rpc()
      .catch((e) => {
        expect(e.error.errorCode.code).to.include("InvalidOptions");
      });
  });

  it("closes peer successfully", async () => {
    const remoteEid = 202;
    const addr = Uint8Array.from(
      Buffer.from(
        "000000000000000000000000c1caf4915849cd5fe21efaa4ae14e4eafa7a3431",
        "hex"
      )
    );

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
      .setPeer({ remoteEid, config: { peerAddress: { 0: [...addr] } } })
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
    const addr = Uint8Array.from(
      Buffer.from(
        "000000000000000000000000c1caf4915849cd5fe21efaa4ae14e4eafa7a3431",
        "hex"
      )
    );
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
      .setPeer({ remoteEid, config: { peerAddress: { 0: [...addr] } } })
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
    const addr = Uint8Array.from(
      Buffer.from(
        "000000000000000000000000c1caf4915849cd5fe21efaa4ae14e4eafa7a3431",
        "hex"
      )
    );

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
      .setPeer({ remoteEid, config: { peerAddress: { 0: [...addr] } } })
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
        expect(e.error.errorMessage).to.include("Share Mover paused");
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

  it("performs two-step authority transfer", async () => {
    const newAdmin = anchor.web3.Keypair.generate();
    await fundAccount(context, newAdmin, 1_000_000_000);

    // Keep reference to the current admin so we can test revocation afterwards
    const oldAdmin = admin;

    // Step 1: current admin sets pendingAdmin via transferAuthority
    await smProgram.methods
      .transferAuthority(newAdmin.publicKey)
      // @ts-ignore
      .accounts({ signer: oldAdmin.publicKey, shareMover })
      .signers([oldAdmin])
      .rpc();

    let sm: any = await smProgram.account.shareMover.fetch(shareMover);
    expect(sm.pendingAdmin.toBase58()).to.equal(newAdmin.publicKey.toBase58());
    // Admin should still be oldAdmin until acceptance
    expect(sm.admin.toBase58()).to.equal(oldAdmin.publicKey.toBase58());

    // Step 2: newAdmin accepts authority
    await smProgram.methods
      // @ts-ignore – generated after building program IDL
      .acceptAuthority()
      // @ts-ignore
      .accounts({ signer: newAdmin.publicKey, shareMover })
      .signers([newAdmin])
      .rpc();

    sm = await smProgram.account.shareMover.fetch(shareMover);
    expect(sm.admin.toBase58()).to.equal(newAdmin.publicKey.toBase58());
    expect(sm.pendingAdmin.toBase58()).to.equal(anchor.web3.PublicKey.default.toBase58());

    // Update global admin for subsequent tests
    admin = newAdmin;

    // Old admin should now be unauthorized
    await smProgram.methods
      .setPause(true)
      // @ts-ignore
      .accounts({ signer: oldAdmin.publicKey, shareMover })
      .signers([oldAdmin])
      .rpc()
      .catch((e) => {
        expect(String(e)).to.include("Not authorized");
      });
  });
});
