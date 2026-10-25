// Where the page finds the chain and its canvas. Everything else (the coin,
// the canvas size, prices, palette and times) is read from the canvas's own
// configuration record on chain.
//
// For development, the query string overrides both:
//   ?node=http://127.0.0.1:28441&canvas=<ContractId>

export const DEFAULT_NODE = 'https://node1.ting-node.com';

/** Per network, by ChainId: its name, and the canvas ContractId once deployed. */
export const NETWORKS = {
  '15d6549cfacd816f835c632b4c67308d1c63e642f4cbf4049368430670705107': {
    name: 'Ting',
    canvas: '0692550ceacd8fd51f03712df37bc1f56cfbe050008d53728549bec60cfec089',
  },
  '8578787146be1ef0aacc797754001290272915e89cd9e5784fe1368e4c2131bc': {
    name: 'Development chain',
    canvas: '',
  },
};

/**
 * CodeHashes the page insists on before it signs anything: the canvas program
 * this page was written for (canvas.wasm), the reference coin, and the
 * reference P-256 policy its wallet signs with (Ting wiki: programs).
 */
export const CODE_HASHES = {
  canvas: '33114e9b3f788d657c7fc6586fe13c0ebbea235b4c8fffb49f5d4e804f410e28',
  coin: 'c675a4b753b61b50ae4b63cde122171f8f2bfb9a05a92df895633ca8c351e4d6',
  policyP256: 'f065bf6d04a34ecbbeb94fb91571ccb2c08c6070cffd2ea4df948b46cda5ef06',
};

/**
 * The canonical deployments of policy-p256 (Ting wiki: programs, canonical
 * deployment), whose CodeHash the page checks on the node.
 */
export const POLICY_P256 = {
  '15d6549cfacd816f835c632b4c67308d1c63e642f4cbf4049368430670705107': '35d2b107de4b2a738a8190be18ccfd35d9bac45da094cfa4281a3a4b178852b3',
  '8578787146be1ef0aacc797754001290272915e89cd9e5784fe1368e4c2131bc': '34ddc75c0463fd2d1542127fbf0fe92ba41bd4fbfba4e473d3aa941e74ab3b5e',
};

/** Pixels in one paint at most: one signature, one transaction. */
export const MAX_DRAFT = 1000;
