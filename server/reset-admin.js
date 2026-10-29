const bcrypt = require('bcrypt');
const db = require('./database/query');

async function resetAdminPassword() {
  const newPassword = 'NewAdminPass123!';
  const hash = await bcrypt.hash(newPassword, 12);
  
  console.log('New password hash:');
  console.log(hash);
  
  await db.run(
    'UPDATE users SET password_hash = $1, must_change_password = FALSE, updated_at = CURRENT_TIMESTAMP WHERE id = 1',
    [hash]
  );
  
  console.log('\nAdmin password has been reset!');
  console.log('New credentials:');
  console.log('Username: admin');
  console.log('Password: ' + newPassword);
}

resetAdminPassword().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
