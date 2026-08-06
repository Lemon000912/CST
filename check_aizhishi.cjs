const { Pool } = require('pg');

const pgPool = new Pool({
  connectionString: 'postgresql://postgres:123456@127.0.0.1:5432/material_kb'
});

async function checkTable() {
  try {
    // 获取表结构
    const columns = await pgPool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'aizhishi_papers'
      ORDER BY ordinal_position
    `);
    
    console.log('=== aizhishi_papers 表结构 ===');
    columns.rows.forEach(col => {
      console.log(`${col.column_name}: ${col.data_type}`);
    });
    
    // 获取一条样例数据
    const sample = await pgPool.query(`
      SELECT * FROM aizhishi_papers LIMIT 1
    `);
    
    console.log('\n=== 样例数据 ===');
    if (sample.rows.length > 0) {
      const row = sample.rows[0];
      Object.keys(row).forEach(key => {
        const value = row[key];
        console.log(`${key}: ${value ? (value.toString().substring(0, 50) + (value.toString().length > 50 ? '...' : '')) : 'NULL'}`);
      });
    }
    
  } catch (e) {
    console.error('Error:', e.message);
  } finally {
    await pgPool.end();
  }
}

checkTable();
