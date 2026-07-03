const fs = require('node:fs');
const path = require('node:path');
const { ethers, network } = require('hardhat');

// 14-day refund window and a generous deployer mint, so a local maintainer has
// plenty of test USDC to fund bounties with.
const REFUND_WINDOW = 14n * 24n * 60n * 60n;
const DEPLOYER_MINT = 1_000_000n * 10n ** 6n; // 1,000,000 USDC (6 decimals)

// Deploy BountyEscrow (and a MockUSDC unless USDC_ADDRESS points at an existing
// token) to whatever network this is run against, then write the addresses to
// deployments/<network>.json and print the api/.env lines.
// The escrow's authorizedCaller — the backend hot wallet that calls release() —
// defaults to the second local signer, but is overridden by AUTHORIZED_CALLER on
// networks (like Arbitrum Sepolia) that expose only the deployer account. Set
// MINT_TO to also mint test USDC to a sponsor wallet (e.g. a MetaMask address).
async function main() {
  const [deployer, backend] = await ethers.getSigners();
  const authorizedCaller = process.env.AUTHORIZED_CALLER || backend?.address;
  if (!authorizedCaller) {
    throw new Error('No authorizedCaller: set AUTHORIZED_CALLER or run on a multi-account network');
  }

  // Target an existing ERC-20 (e.g. Circle's USDC on Arbitrum Sepolia) when
  // USDC_ADDRESS is set; otherwise deploy a fresh mintable MockUSDC for local
  // and self-funded testing. Real USDC cannot be minted — fund the sponsor
  // wallet from the Circle faucet instead.
  let usdcAddress = process.env.USDC_ADDRESS;
  if (usdcAddress) {
    console.log(`Using existing USDC at ${usdcAddress} (skipping MockUSDC deploy/mint).`);
  } else {
    const usdc = await (await ethers.getContractFactory('MockUSDC')).deploy();
    await usdc.waitForDeployment();
    await (await usdc.mint(deployer.address, DEPLOYER_MINT)).wait();
    // Fund a sponsor wallet with test USDC so it can create+fund bounties.
    if (process.env.MINT_TO && process.env.MINT_TO !== deployer.address) {
      await (await usdc.mint(process.env.MINT_TO, DEPLOYER_MINT)).wait();
    }
    usdcAddress = await usdc.getAddress();
  }

  const escrow = await (
    await ethers.getContractFactory('BountyEscrow')
  ).deploy(usdcAddress, authorizedCaller, REFUND_WINDOW);
  await escrow.waitForDeployment();

  const out = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    usdc: usdcAddress,
    escrow: await escrow.getAddress(),
    authorizedCaller,
    deployer: deployer.address,
    deployBlock: await ethers.provider.getBlockNumber(),
  };

  const dir = path.join(__dirname, '..', 'deployments');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${network.name}.json`), `${JSON.stringify(out, null, 2)}\n`);

  console.log('Deployed BountyEscrow:', out);
  console.log('\nAdd these to api/.env:');
  console.log(`CHAIN_ID=${out.chainId}`);
  console.log(`ESCROW_ADDRESS=${out.escrow}`);
  console.log(`INDEXER_START_BLOCK=${out.deployBlock}`);
  console.log('\nAdd these to the frontend .env.local:');
  console.log(`NEXT_PUBLIC_ESCROW_ADDRESS=${out.escrow}`);
  console.log(`NEXT_PUBLIC_USDC_ADDRESS=${out.usdc}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
