const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const axios = require('axios');

const app = express();
app.use(express.json({ limit: '20mb' }));

const API_KEY = process.env.API_KEY || 'change-me';
const DEOBF_SU_KEY = process.env.DEOBF_SU_KEY || '';
const LURAPH_DIR = path.join(__dirname, 'tools', 'luraph');

// ===== Setup (clone luraph at boot) =====
function setupTools() {
  if (!fs.existsSync(LURAPH_DIR)) {
    try {
      fs.mkdirSync(path.join(__dirname, 'tools'), { recursive: true });
      execSync(
        `git clone --depth 1 https://github.com/larpcorrupt/luraph-v15-v14.x-deobfuscator.git "${LURAPH_DIR}"`,
        { timeout: 120000, stdio: 'ignore' }
      );
      console.log('[setup] luraph cloned');
    } catch (e) {
      console.log('[setup] luraph clone failed:', e.message);
    }
  }
}

// ===== Auth =====
const auth = (req) => req.headers['x-api-key'] === API_KEY;

// ===== Detect =====
const SIGS = {
  luraph: ['LPH_ENCSTR', 'LPH_CRASH', 'LPH_ENCFUNC', 'vmmap', 'Luraph'],
  moonveil: ['MoonVeil', 'Veil', 'MV_'],
  moonsec: ['MoonSec', 'getfenv'],
  ironbrew: ['return(function(...)'],
};

function detect(code) {
  const head = code.slice(0, 3000);
  let best = null, bestScore = 0;
  for (const [name, pats] of Object.entries(SIGS)) {
    const s = pats.filter(p => head.includes(p)).length;
    if (s > bestScore) { best = name; bestScore = s; }
  }
  return best;
}

// ===== Command runner =====
function runCmd(cmd, args, cwd, timeout = 110000) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd });
    let stdout = '', stderr = '';
    p.stdout.on('data', d => stdout += d);
    p.stderr.on('data', d => stderr += d);
    const t = setTimeout(() => { p.kill(); reject(new Error('timeout')); }, timeout);
    p.on('close', code => { clearTimeout(t); resolve({ code, stdout, stderr }); });
    p.on('error', reject);
  });
}

// ===== Luraph =====
async function runLuraph(code, version) {
  if (!fs.existsSync(LURAPH_DIR)) return 'ERROR: luraph not installed on server.';
  const tmp = path.join('/tmp', 'deob_' + Date.now() + '.lua');
  const out = tmp + '.out';
  fs.writeFileSync(tmp, code);

  const attempts = [
    ['python3', ['cli.py', '--input', tmp, '--version', version, '--output', out]],
    ['python3', ['main.py', '-i', tmp, '-v', version, '-o', out]],
    ['python3', ['deob.py', tmp, out]],
  ];

  for (const [cmd, args] of attempts) {
    try {
      await runCmd(cmd, args, LURAPH_DIR);
      if (fs.existsSync(out) && fs.statSync(out).size > 0) {
        return fs.readFileSync(out, 'utf8');
      }
    } catch (e) {}
  }
  return 'ERROR: luraph deobfuscation failed — check tool CLI on server.';
}

// ===== MoonVeil (external API) =====
async function runMoonveil(code, version) {
  if (!DEOBF_SU_KEY) return 'ERROR: MoonVeil needs DEOBF_SU_KEY env var (deobfuscate.su).';
  try {
    const r = await axios.post('https://deobfuscate.su/api/run',
      { code, type: 'moonveil', version },
      { headers: { Authorization: `Bearer ${DEOBF_SU_KEY}` }, timeout: 120000 }
    );
    return r.data.result || JSON.stringify(r.data);
  } catch (e) {
    return 'ERROR: MoonVeil API — ' + e.message;
  }
}

// ===== Routes =====
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/api/health', (req, res) => res.json({
  status: 'alive',
  luraph: fs.existsSync(LURAPH_DIR),
  moonveil: !!DEOBF_SU_KEY,
}));

app.post('/api/detect', (req, res) => {
  if (!auth(req)) return res.status(401).json({ error: 'unauthorized' });
  const code = (req.body || {}).code || '';
  res.json({ type: detect(code) });
});

app.post('/api/deob', async (req, res) => {
  if (!auth(req)) return res.status(401).json({ error: 'unauthorized' });
  const { code, tool, version } = req.body || {};
  if (!code) return res.status(400).json({ error: 'no code' });

  let t = tool || 'auto';
  if (t === 'auto') {
    t = detect(code);
    if (!t) return res.status(400).json({ error: 'cannot detect obfuscator' });
  }

  try {
    let result;
    if (t === 'luraph') result = await runLuraph(code, version || 'v15');
    else if (t === 'moonveil') result = await runMoonveil(code, version || 'v2.1');
    else if (t === 'moonsec') result = 'Moonsec needs .NET SDK — run locally.';
    else return res.status(400).json({ error: 'unknown tool: ' + t });
    res.json({ result, detected: detect(code) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== Boot =====
setupTools();
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('[server] listening on ' + PORT));
