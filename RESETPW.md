From the project's backend folder (where node_modules has bcryptjs):

bash
    cd path/to/backend
    node -e "require('bcryptjs').hash('adminssz', 12).then(h => console.log(h))"

That prints a hash like $2b$12$abc...xyz. Copy it.

Then connect to MySQL and run the update:

bash
mysql -u root -p booking_system

Once inside the mysql> prompt:

sql
UPDATE companies
SET password_hash = '$2b$12$r3L46VvqN8ebEHrXONjUYu/Svjb.xjZSrES7yA9ogBqFXh7j3hpWO', token_version = token_version + 1
WHERE email = 'newcompany1@ssz.com';

then may exit


-- Step 1: hash your new password first (run in your server folder)
--   node hash-password.js "YourNewPassword"

-- Step 2: paste the printed hash below, then run this
UPDATE platform_admins
SET password_hash = '$2b$12$kRED5mwEGC9SaR1jlFEA7uKPC6OQyNAYvAKAVrKcn9OfMeZBmkU7u'
WHERE email = 'admin@ssz.com';

-- then exit