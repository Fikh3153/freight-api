// 货代信用评价 - 通用后端 (Express + PostgreSQL)
// 支持 Sealos / Vercel / Railway / 任意平台部署
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

// PostgreSQL 连接 - 从环境变量读取
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/freight',
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});

// 启动时建表
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS companies (
        id TEXT PRIMARY KEY DEFAULT ('c' || floor(extract(epoch from now()) * 1000)::text),
        name TEXT NOT NULL, port TEXT NOT NULL, city TEXT DEFAULT '未知',
        lines TEXT[] DEFAULT '{}', verified BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS reviews (
        id SERIAL PRIMARY KEY,
        company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
        content TEXT DEFAULT '', nickname TEXT DEFAULT '匿名用户',
        phone_hash TEXT DEFAULT '', phone_masked TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT now(), reported BOOLEAN DEFAULT false
      );
      CREATE TABLE IF NOT EXISTS appeals (
        id SERIAL PRIMARY KEY,
        review_id INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
        company TEXT NOT NULL, content TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now()
      );
    `);
    // 种子数据
    const { rows } = await client.query('SELECT COUNT(*) as cnt FROM companies');
    if (parseInt(rows[0].cnt) === 0) {
      await client.query(`
        INSERT INTO companies (name, port, city, lines, verified) VALUES
        ('上海港通国际货运代理有限公司','上海港','上海','{"东南亚","欧洲"}',true),
        ('宁波海纳捷运物流有限公司','宁波港','宁波','{"美西","美东"}',true),
        ('深圳速达国际货代有限公司','深圳港','深圳','{"中东","非洲"}',true),
        ('广州远洋国际物流有限公司','广州港','广州','{"东南亚","欧洲","地中海"}',true),
        ('青岛中远海运物流有限公司','青岛港','青岛','{"日韩","东南亚"}',false),
        ('天津渤海国际货代有限公司','天津港','天津','{"欧洲","俄罗斯"}',true)
      `);
    }
    console.log('DB initialized');
  } finally { client.release(); }
}

// ========== API ==========

// 健康检查
app.get('/api/health', async (req, res) => {
  try { await pool.query('SELECT 1'); res.json({ status: 'ok' }); }
  catch(e) { res.status(500).json({ status: 'error' }); }
});

// 获取所有公司（含评分统计）
app.get('/api/companies', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.*, COUNT(r.id)::int as review_count,
        COALESCE(ROUND(AVG(r.rating)::numeric, 1), 0) as avg_rating
      FROM companies c LEFT JOIN reviews r ON c.id = r.company_id
      GROUP BY c.id ORDER BY c.created_at DESC
    `);
    res.json({ code: 0, data: rows });
  } catch(e) { res.status(500).json({ code: 1, msg: e.message }); }
});

// 获取公司评价
app.get('/api/reviews', async (req, res) => {
  try {
    const { company_id } = req.query;
    if (!company_id) return res.json({ code: 1, msg: '缺少 company_id' });
    const { rows: reviews } = await pool.query(
      'SELECT * FROM reviews WHERE company_id=$1 ORDER BY created_at DESC', [company_id]
    );
    // 获取每条评价的申诉
    for (const r of reviews) {
      const { rows: appeals } = await pool.query(
        'SELECT * FROM appeals WHERE review_id=$1 ORDER BY created_at', [r.id]
      );
      r.appeals = appeals;
    }
    res.json({ code: 0, data: reviews });
  } catch(e) { res.status(500).json({ code: 1, msg: e.message }); }
});

// 录入公司
app.post('/api/companies', async (req, res) => {
  try {
    const { name, port, city, lines } = req.body;
    if (!name || !port) return res.json({ code: 1, msg: '公司名称和港口不能为空' });
    const { rows } = await pool.query(
      'INSERT INTO companies (name, port, city, lines) VALUES ($1,$2,$3,$4) RETURNING id',
      [name, port, city || '未知', lines || []]
    );
    res.json({ code: 0, data: { id: rows[0].id } });
  } catch(e) { res.status(500).json({ code: 1, msg: e.message }); }
});

// 提交评价
const BAD_WORDS = ['骗子','坑人','黑心','垃圾','傻逼','操','妈的','fuck','shit','死全家','畜生','狗日','坑货','骗钱','诈骗','无良','黑店','奸商','辣鸡','煞笔','尼玛'];
function filterBad(text) {
  let clean = text; const found = [];
  for (const w of BAD_WORDS) { if (clean.includes(w)) { found.push(w); clean = clean.split(w).join('*'.repeat(w.length)); } }
  return { clean, found };
}

app.post('/api/reviews', async (req, res) => {
  try {
    const { company_id, rating, content, nickname, phone_hash, phone_masked } = req.body;
    if (!company_id || !rating) return res.json({ code: 1, msg: '缺少必要参数' });
    if (rating < 1 || rating > 5) return res.json({ code: 1, msg: '评分范围 1-5' });
    const { clean, found } = filterBad(content || '');
    if (found.length > 0) return res.json({ code: 2, msg: '包含不当词汇: ' + found.join('、') });
    // 防刷
    if (phone_hash) {
      const { rows } = await pool.query(
        "SELECT id FROM reviews WHERE company_id=$1 AND phone_hash=$2 AND created_at > now() - interval '24 hours'",
        [company_id, phone_hash]
      );
      if (rows.length > 0) return res.json({ code: 3, msg: '24小时内已评价过该公司' });
    }
    await pool.query(
      'INSERT INTO reviews (company_id, rating, content, nickname, phone_hash, phone_masked) VALUES ($1,$2,$3,$4,$5,$6)',
      [company_id, rating, clean, nickname || '匿名用户', phone_hash || '', phone_masked || '']
    );
    res.json({ code: 0, data: { ok: true } });
  } catch(e) { res.status(500).json({ code: 1, msg: e.message }); }
});

// 公司回应
app.post('/api/appeals', async (req, res) => {
  try {
    const { review_id, company, content } = req.body;
    if (!review_id || !company || !content) return res.json({ code: 1, msg: '缺少必要参数' });
    await pool.query('INSERT INTO appeals (review_id, company, content) VALUES ($1,$2,$3)', [review_id, company, content]);
    res.json({ code: 0, data: { ok: true } });
  } catch(e) { res.status(500).json({ code: 1, msg: e.message }); }
});

// 启动
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log('Server running on port', PORT));
});
