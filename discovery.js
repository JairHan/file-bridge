const os = require('node:os');
const ipaddr = require('ipaddr.js');

function networkKey(raw, interfaces = os.networkInterfaces()) {
  let address;
  try { address = ipaddr.process(raw); } catch { return null; }
  // Direct LAN hosting: use the server's actual interface prefix, not a guessed /24.
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.internal || !entry.cidr) continue;
      try {
        const [network, prefix] = ipaddr.parseCIDR(entry.cidr);
        if (address.kind() === network.kind() && address.match(network, prefix)) {
          return `lan:${entry.cidr}`;
        }
      } catch { /* Ignore unsupported interface addresses. */ }
    }
  }
  // Public hosting: equal exit addresses are candidates, not proof of a shared LAN.
  return `ip:${address.toNormalizedString()}`;
}

function deviceLabel(agent = '') {
  const platform = /iPhone/i.test(agent) ? 'iPhone' : /iPad/i.test(agent) ? 'iPad'
    : /Android/i.test(agent) ? 'Android' : /Windows/i.test(agent) ? 'Windows'
    : /Macintosh/i.test(agent) ? 'Mac' : /Linux/i.test(agent) ? 'Linux' : '浏览器';
  return platform;
}
module.exports = { networkKey, deviceLabel };
