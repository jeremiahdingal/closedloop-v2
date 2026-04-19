const { execSync } = require('child_process');
const commits = [
  '2985abc8220a2ef5f139b956bf9823e9e0e3578f',
  '33c6703dc2cd8e179a660868a46d7798936992d7',
  '888623d169371a77659d1029a21359da623c3c46',
  'b008540498a25c3441ebc140f25361a7d592abf5',
  '238ad15463193eddac78659d62499a516868bb60',
  'f54bb801965b280552fdb335db7f8e6e1376484c',
  '205886d8fd2b30757102e2bafccbdc015072c8f0',
  'af1f445226dc72b0eae71f7785ffa26fa23e486b',
  'b6e0c3cd8ed26cad905177d169cf7064cd3c3b1e',
  '1de11aa3e235e7c67bdf890a64410d0358eaa7a1',
  'a16cf5e868b65543b7ca525421635e2172c6ca5a',
  '45ee9bf8a5c1a5b1d582527e9a4f4910082a3fe7',
  '1df3542e2a9d08931b51abbce234348a056c100e',
  'e6b42629911ca2ab69e43a5dcfe17f977c46e4ce',
  '98b5d280dad366211defbc56d34c3e3e5203e72d',
  'a4f5c4243aa2f185d8960839e2efed47950e81c7',
  'aff680ed07be73e2e1823269c9026bb557722310',
  'adb97b1733bdfac5296cec3cc9760c6c8ef150a9',
  'c1fc356c1c9db12e453a3416690d673651747a69',
  '997f038cbc53a565b4572493fdebacfb297d9122',
];

for (const hash of commits) {
  try {
    const out = execSync(`git show ${hash}:src/orchestration/ticket-runner.ts`, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    const hasExplorer = out.includes('explorerNode');
    const hasCoder = out.includes('coderNode');
    const hasVerify = out.includes('verifyNode');
    const hasBuildPacket = out.includes('buildPacketNode');
    if (hasExplorer || hasCoder || hasVerify || hasBuildPacket) {
      console.log(`FOUND! ${hash}`);
      console.log(`  explorerNode: ${hasExplorer}, coderNode: ${hasCoder}, verifyNode: ${hasVerify}, buildPacketNode: ${hasBuildPacket}`);
      console.log(`  Lines: ${out.split('\n').length}`);
      // Check graph wiring
      const addNodeLines = out.split('\n').filter(l => l.includes('.addNode('));
      console.log(`  Nodes: ${addNodeLines.map(l => l.trim()).join(', ')}`);
    }
  } catch {
    // No ticket-runner.ts in this commit
  }
}
console.log('Done searching', commits.length, 'commits');
