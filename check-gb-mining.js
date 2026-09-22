const { ethers } = require("ethers");

async function main() {
  const rpc = process.argv[2] || "http://127.0.0.1:8888";
  const p = new ethers.JsonRpcProvider(rpc, 224422, { staticNetwork: true });
  const guardianAbi = [
    "function getAllNodes() view returns (tuple(string ip,string name,address owner,uint256 id)[])",
  ];
  const redeemAbi = [
    "event AirdropAccrued(address indexed beneficiary, bytes32 indexed codeHash, uint256 added, uint256 newTotal)",
    "function airdropClaimableAt() view returns (uint64)",
  ];
  const g = new ethers.Contract(
    "0xBC6b53065b5647261396d002bDBA0d3396E0722f",
    guardianAbi,
    p
  );
  const r = new ethers.Contract(
    "0xc71e246DD78B37C2fABc905D340932F28F503433",
    redeemAbi,
    p
  );
  const nodes = await g.getAllNodes();
  console.log("guardian_total", nodes.length);
  for (const ip of [
    "217.160.126.130",
    "217.160.126.124",
    "217.160.126.123",
    "217.160.126.122",
  ]) {
    const n = nodes.find((x) => x.ip === ip);
    console.log(
      "depin",
      ip,
      n ? `id=${n.id} owner=${n.owner}` : "NOT_REGISTERED"
    );
  }
  try {
    const at = await r.airdropClaimableAt();
    console.log("airdropClaimableAt", at.toString());
  } catch (e) {
    console.log("airdropClaimableAt err", e.message);
  }
  const tip = await p.getBlockNumber();
  const topic = r.interface.getEvent("AirdropAccrued").topicHash;
  let acc = 0;
  for (let f = Math.max(0, Number(tip) - 50000); f <= tip; f += 5000) {
    const t = Math.min(f + 4999, tip);
    const logs = await p.getLogs({
      address: r.target,
      fromBlock: f,
      toBlock: t,
      topics: [topic],
    });
    acc += logs.length;
  }
  console.log("AirdropAccrued_last50k", acc);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
