const { Pool } = require('pg');

const pgPool = new Pool({
  connectionString: 'postgresql://postgres:123456@127.0.0.1:5432/material_kb'
});

async function listTables() {
  try {
    // 获取所有表
    const tables = await pgPool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);
    
    console.log('=== 数据库中的所有表 ===');
    tables.rows.forEach(t => {
      console.log(t.table_name);
    });
    
    // 查找包含papers的表
    const paperTables = tables.rows.filter(t => 
      t.table_name.toLowerCase().includes('paper')
    );
    
    console.log('\n=== 包含paper的表 ===');
    paperTables.forEach(t => {
      console.log(t.table_name);
    });
    
  } catch (e) {
    console.error('Error:', e.message);
  } finally {
    await pgPool.end();
  }
}

listTables();
