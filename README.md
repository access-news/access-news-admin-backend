### `./admin_site`

The admin web app to manage users, content, etc.

### `./functions`

Firebase cloud functions.

+ `apply`: Keep the **state store** (or read store) up to date,
   applying each incoming event on top of the current state.

+ `project`: update projections whenever the state store changes.

### `./local_commands`

```javascript
/* `rebuild-projections` rebuilds the projections from
   zero on a local machine.

   Deploying  the  `project`   cloud  function  with  no
   or  empty  `/state_store`   will  take  every  stream
   individually and process them. By the nature of cloud
   function, this  means that  they will be  probably be
   processed more than once and out of order. It can get
   messy and it's just simply cleaner to do it locally.
*/
var p = require('./local_commands/projections.js');

/* `rebuild_state_store`  applies every  event from  the
   event store to rebuild the  state store. The order is
   important here  and cloud functions don't  hold state
   thus the best is to do this locally, before deploying
   the  cloud `apply`  counterpart, if  the state  store
   ever needs to be reset.

   `public_commands`  holds   the  "commands"   in  this
   implementation of CQRS/ES and  works fine so far from
   the Node CLI.
*/
var f = require('./local_commands/admin-functions.js');

// Returns the initialized client and Admin SDK Firebase apps
var a = require('./local_commands/firebase_apps');
```

### `./rules`

Firebase storage and realtime database rules.
