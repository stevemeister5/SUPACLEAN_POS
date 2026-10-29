const bcrypt = require('bcrypt');
const sqlite3 = require('sqlite3').verbose();

async function setAdminPassword() {
  const password = await new Promise((resolve) => {
    const readline = require('readline').createInterface({
      input: process.stdin,
      output: process.stdout
    });
    readline.question('Enter new admin password: ', (pwd) => {
      resolve(pwd);
      readline.close();
    });
  });
  
  const hash = await bcrypt.hash(password, 12);
  console.log('Generated hash:', hash);
  
  const db = new sqlite3.Database('/home/quackyduck/Documents/SUPACLEAN_POS/database/supaclean.db');
  
  await new Promise((resolve, reject) => {
    db.run(
      'UPDATE users SET password_hash = $1, must_change_password = FALSE, updated_at = CURRENT_TIMESTAMP WHERE id = 1',
      [hash],
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
  
  console.log('\nAdmin password updated successfully!');
  console.log('Username: admin');
  console.log('Password: ' + password);
  
  db.close();
}

setAdminPassword().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});