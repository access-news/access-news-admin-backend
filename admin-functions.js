'use strict'
/* Sequence numbers (`seq`) in events and state
   ============================================

   --- STATUS: **empty database** ---

   After `require`ing this file, `apply()` is immediately invoked

   1. fetching the current state from the database
      (which yields `undefined`) and

   2. attaching an `on('child_added',...)` listener on the "/event_store"
      (mutating the state based on incoming events).

   New events are generated via the  `execute()` command. On the very first
   command there is only an empty  STATE_STORE, and the stream's state thus
   will be a  stub (`{seq: 0}`). The event generated  by the command (e.g.,
   "add_person") takes the current state of  the stream and saves its `seq`
   incremented by one.

   E      - `execute()`
   e{num} - event with `seq === num`
   S{num} - stream's state with its `seq` attribute being `num`.
   A      - `apply()`

              EVENT_STORE                            STATE_STORE
   S0 -> E ->    e1       -> A( e1 <= S0) -> false ->    S1
   S1 -> E ->    e2       -> A( e2 <= S1) -> false ->    S2

   When STATE_STORE is deleted or unreachable, the in-memory STATE_STORE
   will be rebuilt the same way when the server is restarted.


   --- STATUS: **Server stopped, new events came in (e3, e4), server restarted** ---

              EVENT_STORE                                      STATE_STORE
   S2 -> E ->    e1       -> A( e1 <= S2 ) -> true  -> no op ->    S2
   S2 -> E ->    e2       -> A( e2 <= S2 ) -> true  -> no op ->    S2
   S2 -> E ->    e3       -> A( e3 <= S2 ) -> false ->             S3
   S3 -> E ->    e4       -> A( e4 <= S3 ) -> false ->             S4

*/

/* SETUP

   https://medium.com/scientific-breakthrough-of-the-afternoon/sending-password-reset-email-after-user-has-been-created-with-firebase-admin-sdk-node-js-1998a2c6eecf
*/

/* INITIALIZING FIREBASE APPS
   ==========================
*/

function init_firebase_admin() {

  const firebase_admin = require('firebase-admin');
  const serviceAccount = require('./access-news-firebase-adminsdk-kvikw-e4024c68e0.json');

  firebase_admin.initializeApp({
    credential: firebase_admin.credential.cert(serviceAccount),
    databaseURL: "https://access-news.firebaseio.com"
  });

  return firebase_admin;
};

const ADMIN_APP = init_firebase_admin();

function init_firebase_client() {

  const firebase_client = require('firebase');
  const config = require('./firebase_client_config.json');
  firebase_client.initializeApp(config);

  return firebase_client;
};

const CLIENT_APP = init_firebase_client();

/* LOW LEVEL FUNCTIONS TO THE EVENT_STORE
   ======================================
*/
/* General outline of the database
   -------------------------------

    /event_store/event_id/event_object
    /streams/stream_id/event_id/event_object
    /state_store/stream_id/latest_values_of_event_fields
*/

var EVENT_VERSION = 0;

function create_event(p) {

  /* This function's only purpose is to make testing easier and enforce fields. */

  /* The "p" (as in "parameters") object:

     "aggregate": From Domain Driven Design. An aggregate is an entity
                  that should have its own identity in the system.

     "stream_id": Unique identifier of the aggregate instance (such as
                  user_id).

                  For  example,  PUBLICATIONS  should be  an  distinct
                  aggregate, becuase even if no content exists yet, we
                  should track when they  were officially added. (This
                  may change of course.)

     "event_name": Verb in  the past tense, describing  what this event
                   adds to the history of the aggregate instance.

     "fields": The data to be persisted with an event. For example,
               "email_added"  would   persist  the   email  address
               associated with a person.

     "version": The EVENT_STORE is immutable, therefore the change of
                a particular event should be marked. There are many
                [event versioning strategies](https://leanpub.com/esversioning/read), and at this point it is
                just used to enable future extensions.

     "seq": "expected_version" in other  event store implementations,
            but  I  think  that  name is  misleading,  especially  if
            one  versions their  events.  It is  a sequential  number
            for  every event  in  the  stream denoting  chronological
            sequence.

            Comparing   timestamps  would   probably   be  a   viable
            alternative,  but  not  used  in  this  project  for  the
            following reasons:

              + The way Firebase databases' server-side timestamps are implemented,
                it is not an option. See more [here](https://stackoverflow.com/questions/51867616/how-to-come-around-firebase-realtime-databases-server-side-timestamp-volatility).

              + To avoid race conditions and make it easier to reason about concurrent
                events in a highly distributed system, it is easier to explicitly
                require sequence numbers. (Maybe not, time will tell.)
  */

  return {
    "aggregate":  p.aggregate,
    "stream_id":  p.stream_id,
    "event_name": p.event_name,
    "fields":     p.fields,
    "timestamp":  ADMIN_APP.database.ServerValue.TIMESTAMP,
    "version":    EVENT_VERSION,
    "seq":        p.seq
  };

}

function create_new_stream_id() {
  return ADMIN_APP.database().ref().push().key;
}

/* "stream_id" is also contained by the event, but I think it is more prudent
   to expose it in here as well. (Especially when seeing the name of the
   function, and `execute()` explicitly requires "stream_id" anyway.)
*/
function append_event_to_stream(stream_id, event) {

  const db = ADMIN_APP.database();
  const event_id = db.ref("event_store").push().key;

  var updates = {};
  // updates[`/streams/${stream_id}/${event_id}`] = event;
  updates[`/event_store/${event_id}`] = event;

  /* `firebase.database.Reference.update()` returns a void promise,
     that is used to synchronize writes in `public_commands`, such
     as `add_user()`.
  */
  return db.ref().update(updates);
};

/* HELPERS FOR `EXECUTE()` AND `APPLY()`
   =====================================
*/

/* Used in commands to verify required fields. A very primitive version of
   `cast()` in Ecto Changeset for Elixir applications.
*/
function verify_payload_fields(p) {

  /* The "p" (as in "parameters") object:

     "required_fields": Array of event fields. For example,
                        `[ "first_name", "last_name"]` for "add_person".

     "payload": An object holding the values for to be held by the event
                emitted by the command. For "add_person", it would be
                `{ first_name: "Lo", last_name: "Fa"}`.
  */

  var fields = {};

  const payload_properties = Object.keys(p.payload);

  if (payload_properties.length !== p.required_fields.length) {
    throw `Expected fields: ${p.required_fields}, got: ${payload_properties}`
  }

  for (var i in payload_properties) {

    const payload_prop = payload_properties[i];

    if (p.required_fields.includes(payload_prop) === false) {
      throw `Required fields ${p.required_fields} do not match ${payload_prop}`
    }

    fields[payload_prop] = p.payload[payload_prop];
  }

  return fields;
}

function sanitize_key(key) {
  return key.split('').map(
    function(c) {
      switch (c) {
        case ".": return "<dot>";
        case "#": return "<hash>";
        case "$": return "<dollar>";
        case "/": return "<forward-slash>";
        case "[": return "<opening-bracket>";
        case "]": return "<closing-bracket>";
        default:  return c;
      }
    }).join('');
}

const event_handler_factories = {

  /* Attribute of a "state" (i.e., cumulative state of an aggregate
     instance)  in  the  STATE_STORE.   Events  contain  one  datum
     (usually),  such as  "email_added"  has an  "email" field  for
     example. But a person can have more email addresses associated
     to  them,  hence  the aggregate  instance's  cumulative  state
     should reflect this,  thus it would be called  "emails" in the
     STATE_STORE.

      The "p" (as in "parameters") object in the factories below it
      therefore mostly to make pluralization rules explicit:

      "attribute": The plural name of the attribute in the state.

      "event_field": The singular event field name for the datum.
  */

  /* "state" = the cumulative state of an aggregate instance. */

  /* NOTE:
     It could be that the  same entity (e.g., phone number) belongs
     to multiple  people, but using  a `push()` ID they  are unique
     values that  can be traced  back to individuals. On  the other
     hand, a projection  can be built to track how  many people are
     using the same contact details (i.e., same address, same phone
     number, email, etc.).
  */

  /* For list attributes of an aggregate, such as emails,
      phone numbers, etc.

      After dropping the "reason" and "from" fields (where included),
      there should only be one field remaining. (See commands above.)
      If this is not the case, I messed up. Again.
  */
  for_multi: function(p) {

    /* The "p" (as in "parameters") object in the factories below it
       therefore mostly to make pluralization rules explicit:

            "attribute": The plural name of the attribute in the state.

            "event_field": The singular event field name for the datum.

            "onoff": A list of entities that do not need unique IDs (e.g.,
                     user groups). Key-value pairs such as { "item": true }
                     are also the only way to save lists in Firebase DB.
    */

    return function(event_snapshot, state) {

      const event    = event_snapshot.val();
      const event_id = event_snapshot.ref.getKey();

      /* This covers the "*_(added|created|etc)" events by
         adding the collection name (gyujtonev) to group the
         same entities (phone numbers, emails etc.)
      */
      if (state[p.attr] === undefined) {
        state[p.attr] = {};
      }

      delete event.fields.reason;

      if ( event.fields.from !== undefined ) {

        state[p.attr][sanitize_key(event.fields.from)] = null;
        delete event.fields.from;
      }

      const k = Object.keys(event.fields)[0];
      const v = event["fields"][k];

      state[p.attr][sanitize_key(v)] = !p.drop ? event_id : null;

      console.log("\n");
      console.log(state);
      console.log("\n");

      // Return the mutated state.
      return state;
    }
  },

  for_person_name: function() {

    return function(event_snapshot, state) {

      const event = event_snapshot.val();

      if (event.fields.reason) {
        event.fields.reason = null;
      }
      state["name"] = event.fields;

      return state;
    }
  }
}

function command_factory(p) {

  /* The "p" (as in "parameters") object:

         "event_name": E.g., 'email_added'

         "required_fields": First input for `verify_payload_fields()`
                            (see comments there).

         "constraint": Callback   taking    the   fields    returned   from
                       `verify_payload_fields()`  and  it  return  nothing,
                       only throws if some domain logic is not honoured.

                       See "add_to_group"  for an example,  where arbitrary
                       strings can  be supplied, but the  only valid groups
                       are "admins", "readers", and "listeners".
  */

  return function(state, execute_params) {

    /* The `execute_params` object is the usual "p" object in functions,
       handed down from `execute()`:

           "aggregate" \
           "stream_id"  > see `create_event()`'s "p" object comments.
           "seq"       /

           "commandString": E.g., "person_added".

           "payload": Second input for `verify_payload_fields()`
                       (see comments there).

           "callback": Function for adding constraints to a command.
                       Currently nothing uses it.
    */

    const fields =
      verify_payload_fields({
        "required_fields": p.required_fields,
        "payload": execute_params.payload
      });

    if (p.constraint !== undefined) {
      p.constraint(fields);
    }

    /* The "callback" parameter is to include any logic that
        needs to be enforced, and either throw error(s) or
        create the appropriate event.

        If none is provided, it will simple return the "fields"
        parameter unchanged.
    */
    if (execute_params.callback === undefined) {
      execute_params.callback = function(state, fields) { return fields };
    }

    return create_event({
      "aggregate":  execute_params.aggregate,
      "stream_id":  execute_params.stream_id,
      "event_name": p.event_name,
      "fields":     execute_params.callback(state, fields),
      "timestamp":  ADMIN_APP.database.ServerValue.TIMESTAMP,
      "version":    EVENT_VERSION,
      "seq":        execute_params.seq
    });
  };
}

/* COMMANDS (for `execute()`) AND EVENT HANDLERS (for `apply()`)
   =============================================================
*/

function group_constraint(fields) {

  const valid_groups = ['admins', 'listeners', 'readers'];

  if (valid_groups.includes(fields.group) !== true) {
    throw `"group" must be one of ${valid_groups}`
  }
}

const aggregates = {

  person: {

    commands: {

      "add_person":
        command_factory({
          event_name:      'person_added',
          required_fields: ['first_name', 'last_name']
        }),

      "change_name":
        command_factory({
          event_name:      'person_name_changed',
          required_fields: ['first_name', 'last_name', 'reason']
        }),

      "add_email":
        command_factory({
          event_name:      'email_added',
          required_fields: ['email'],
        }),

      "update_email":
        command_factory({
          event_name:      'email_updated',
          required_fields: ['from', 'to', 'reason'],
        }),

      "delete_email":
        command_factory({
          event_name:      'email_deleted',
          required_fields: ['email', 'reason']
        }),

      "add_phone_number":
        command_factory({
          event_name:      'phone_number_added',
          required_fields: ['phone_number'],
        }),

      "update_phone_number":
        command_factory({
          event_name:      'phone_number_updated',
          required_fields: ['from', 'to', 'reason'],
        }),

      "delete_phone_number":
        command_factory({
          event_name:      'phone_number_deleted',
          required_fields: ['phone_number', 'reason']
        }),

      "add_to_group":
        command_factory({
          event_name:      "added_to_group",
          required_fields: ['group'], // 'user_id' omitted as it is the stream_id for now
          constraint:      group_constraint
        }),

      "remove_from_group":
        command_factory({
          event_name:      "removed_from_group",
          required_fields: ['group', 'reason'],
          constraint:      group_constraint
        }),
    },
  },
};

/* `EXECUTE()` AND `APPLY()`
   =========================
*/

/* In-memory STATE_STORE */
var state_store = {};

/* One justification for the current  architecture is that the concerns are
   nicely separated, the operations of the  two functions do not overlap in
   any way:

       * `execute()` creates the events and touches the EVENT_STORE
       * `apply()`   creates the next state and mutates the STATE_STORE

   Race conditions can be a concern  as there are a couple network requests
   towards the database between the two (see [Fallacies of distributed computing](https://en.wikipedia.org/wiki/Fallacies_of_distributed_computing)),
   but steps have been take to mitigate these:
+ **commands are idempotent**

       For example,  if multiple admins  want to delete  that same email  for a
       user, submit  a command,  and all succeed:  the EVENT_STORE  records all
       attempts, and  applying the first event  will update the state,  but the
       rest will reinforce the same truth only.

     + **`execute()` requires explicit "stream_id"**

       Imagine a command to create a new stream and multiple subsequent ones to
       update it  (e.g., new person and  adding emails and groups).  Each event
       contains  a "stream_id",  therefore  if a  new  stream (i.e.,  aggregate
       instance) can be created in the STATE_STORE from any of them.

   Also, for the  record, some constraints needs to enforced  by the UI/API
   and try  to prevent the users  to shoot themselves in  the leg. Chaining
   the two  functions together and  skipping the messy event  handler stuff
   would be easy, but there would be downsides too.
*/
function execute(p) {

  /* The "p" (as in "parameters") object:

         "aggregate" \
         "stream_id"  > see `create_event()`'s "p" object comments.
         "seq"       /

         "commandString": E.g., "person_added".

         "payload": Second input for `verify_payload_fields()`
                     (see comments there).

         "callback": Function for adding constraints to a command.
                     Currently nothing uses it.
  */

  const command = aggregates[p.aggregate]["commands"][p.commandString];

  if (command === undefined) {
    throw `No ${commandString} in ${p.aggregate} aggregate.
           Choose one from ${Object.keys(aggregates[p.aggregate]["commands"])}`;
  }

  /* Defined with `const` because `execute()`  only uses the state to inspect
     it in order  to make decisions on  what to put in  the generated events,
     but will never mutate it.
  */
  const state = (state_store[p.stream_id] !== undefined) ? state_store[p.stream_id] : {};
  const event = command(state, p);

  /* Returns the promise that `append_event_to_stream()` also returns. */
  return append_event_to_stream(p.stream_id, event);
};

function apply() {

  /* Fetch previous state on startup (or when executing `apply()`).

     TODO: Reimplement this to fetch streams lazily on demand (issue #5)
  */
  ADMIN_APP.database().ref("/state_store").once("value").then(

    function(state_snapshot){

      /* Is there data in "/state_store"? */
      if (state_snapshot.val() !== null) {
        state_store = Object.assign(state_store, state_snapshot.val());
      } else {
        state_store = {};
      }
    }

  ).then(

    function() {

      const event_store = ADMIN_APP.database().ref("/event_store");

      event_store.on(
        'child_added',
        function(event_snapshot) {

          const event = event_snapshot.val();
          const stream_id = event.stream_id;

          if ( state_store[stream_id] === undefined ) {
            /* Two cases when we can end up here:

               1. "/state_store" in DB  is missing entirely,
                  therefore  condition  will return  `false`
                  for every `stream_id`.

               2. The server was down while a new stream was
                  started in  the EVENT_STORE,  therefore no
                  listener  was  active  to handle  it,  and
                  events are flooding in upon restart.

               To jump  start this  process, a  very minimal
               state-stub  has  to   be  supplied  to  allow
               applying events on top.

               NOTE:
               The  "aggregate"  attribute  is  not  queried
               past  this  point,  but  it  is  needed.  The
               `aggregates.<type>.event_handlers`  are  only
               concerned with  the events'  "fields" object,
               and  the  generated  "next_state"  is  simply
               merged  with  the  current state  (adding  or
               overwriting attributes). When  the next event
               is  fed  to  `apply()`, it  would  query  the
               "aggregate" attribute above,  and if missing,
               it  would yield  `undefined`  when trying  to
               find  the right  event handler,  crashing the
               process.
            */
            state_store[stream_id] =
              {
                aggregate: event.aggregate,
                seq: 0
              };
          }

          /* "state" = the cumulative state of an aggregate instance. */
          const state = state_store[stream_id];

          function check() {
            const event_id = event_snapshot.ref.getKey();
            const action = (event.seq < state.seq) ? "no op" : "replay";
            console.log(`Stream: ${stream_id} event: ${event_id} ${event.event_name}`);
            console.log(`  Action: ${action} (event_seq: ${event.seq}, state.seq: ${state.seq})`);
            if (action === "replay") {
              console.log("^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^\n");
            }
          }
          check();

          /* Not using  `<=` because there may  be multiple events
             with  the  same  `seq` (because  of  stupidity,  race
             conditions etc.) and this allows applying them
          */
          if ( event.seq < state.seq ) {
            return;
          } else {

            state["seq"] = event.seq;

            function get_event_handler() {

              const f = event_handler_factories;

              switch (event.event_name) {

                case "person_added":
                case "person_name_changed":
                  return f.for_person_name();

                case "email_added":
                case "email_updated":
                  return f.for_multi({
                    attr: "emails",
                  });
                case "email_deleted":
                  return f.for_multi({
                    attr: "emails",
                    drop: true
                  });

                case "phone_number_added":
                case "phone_number_updated":
                  return f.for_multi({
                    attr: "phone_numbers",
                  });
                case "phone_number_deleted":
                  return f.for_multi({
                    attr: "phone_numbers",
                    drop: true
                  });

                case "added_to_group":
                  return f.for_multi({
                    attr: "groups",
                  });
                case "removed_from_group":
                  return f.for_multi({
                    attr: "groups",
                    drop: true
                  });

                case "session_started":
                case "session_time_updated":
                case "session_ended":
                  return f.for_multi({
                    attr: "sessions",
                  });

                case "recording_added":
                  return f.for_multi({
                    attr: "recordings"
                  });
              }
            }

            get_event_handler()(event_snapshot, state);

            ADMIN_APP.database().ref("/state_store").child(stream_id).update(state);
          }
        }
      );
    }
  )
}

/* Leaving this here for future reference as to why
   Firebase Cloud Functions is not the right solution.
   (At least, not right now. Will see when more time is
   available.)

   https://medium.com/scientific-breakthrough-of-the-afternoon/cqrs-es-and-firebase-cloud-functions-ed67ea151444

    function cloud_apply() {
    }
*/

/* PUBLIC COMMANDS
   ===============
*/

/* The  rationale  behind this  collection  of  commands is  that  Firebase
   functions  are asynchronous,  therefore  to add  events  in order,  CQRS
   commands  need  to be  chained.  (Again,  the fallacies  of  distributed
   computing  are still  in  effect,  but this  is  one  mitigation of  any
   potential misordered writes.)
*/
const public_commands = {

  add_user: function(p) {
  /* p =
     {
         (REQUIRED) first_name: "",
         (REQUIRED) last_name:  "",
                    username:   "", // "first_name" + "last_name" by default
         // (REQUIRED) user_id:    "", // i.e., person stream_id
         (REQUIRED) email:      "",
                    address:    "",
                    phone_number: "",
         (REQUIRED) account_types: [ "admin" | "reader" | "listener" ], // array
     }
  */
  /* USER_ID = person INSTANCE STREAM_ID

     A person can be member to multiple groups, but using the same
     "stream_id" for all; they cannot be added multiple times anyway
     and easier to check for presence.

     QUESTION: Is this a good idea?

     ANSWER: No, but with Firebase, there can only be one user with the
             same email, therefore group membership is an artificial
             construct, and authorization will be implemented using
             security rules.
  */

     // TODO create a function for optional parameter checks
     if (p.username === undefined) {
       p["username"] = `${p.first_name} ${p.last_name}`;
     }

     const group_commands = p.account_types.map(
       function(group) {
         return [ "add_to_group", { group: `${group}s` }];
       }
     );

     const user_id = create_new_stream_id();

     return chain(
       {
         stream_id: user_id,
         aggregate: "person",
         start_seq: 1,
         commands:  [
           [ "add_person", {
             "first_name": p.first_name,
             "last_name":  p.last_name
           }],
           [ "add_email",{
             "email": p.email
           }],
           // [ "add_phone_number",{
           //     "phone_number": p.phone_number
           // }]
         ].concat(group_commands)
       }
     ).then( function() {

       return ADMIN_APP.auth().createUser(
         {
           "disabled":    false,
           "displayName": p.username,
           "email":       p.email,
           "phoneNumber": p.phone_number,
           "uid":         user_id
         }
       )
     }).then( function() {

       /* The user gets an email upon subscribing them to change their
          passwords. This is done so because reader and listener signups
          are centralized. (For now.)
       */
       return CLIENT_APP.auth().sendPasswordResetEmail(p.email);

     }).catch( function(e) {

       console.log(e)
     });
  },
}

/* On success: returns Promise containing non-null admin.auth.UserRecord. */
/* TODO Make this a transaction.

        It is  nice that the  promise chaining below  ensures the
        sequence of commands, but if one fails, the chain breaks,
        but  what has  been done  will not  get undone.  This may
        not  be  an  issue  because of  command  idempotency  and
        EVENT_STORE immutability, but may be nicer.

        ! Checks  for ALL  commands participating  in a  public
        ! command  should  be  done  beforehand so  as  not  to
        ! pollute  the  EVENT_STORE  with balancing  events  if
        ! params are not good.
*/
function chain(p) {
  /* p = {
           stream_id: "stream_id",
           aggregate: "person",
           start_seq: 1,
                       ---command---  ---payload-------------
           commands:  [["add_person", { first_name: .., ...], [...], ... ]
         }
  */

  const first_execute_params =
    {
      stream_id:     p.stream_id,
      aggregate:     p.aggregate,
      commandString: p.commands[0][0],
      payload:       p.commands[0][1],
      seq:           p.start_seq
    }

  p.commands.shift();

  const first_execute_promise = execute(first_execute_params);

  function add_then(promise, commands_array) {

    p.start_seq += 1;
    const seq = p.start_seq;

    const command = commands_array.shift();

    const new_promise =
      promise.then(function() {
        execute(
          {
            stream_id: p.stream_id,
            aggregate: p.aggregate,
            commandString: command[0],
            payload:       command[1],
            seq:       seq
          }
        )
      });

    if ( commands_array.length === 0 ) {
      return new_promise;
    } else {
      return add_then(new_promise, commands_array);
    }
  }

  return add_then(first_execute_promise, p.commands);
}

module.exports = {
  create_new_stream_id,
  verify_payload_fields,
  append_event_to_stream,
  EVENT_VERSION,
  ADMIN_APP,
  CLIENT_APP,
  aggregates,
  execute,
  apply,
  chain,
  state_store,
  public_commands
};

/*
f.public_commands.add_user({first_name: "Attila", last_name: "Gulyas", username: "", email: "toraritte@gmail.com", account_types: ["admin", "reader"]})
*/

/* TEST EMAIL COMMANDS

var f = require('./admin-functions.js');

  // + Idempotent? Yes.
  //   Issuing "add_email" multiple times will only changes the event_id
  //   associated with the email, but won't add duplicates.
f.execute({seq: 5, stream_id: "-LL0WL4l6qwaCNndM44l", aggregate: "person", commandString: "add_email", payload: {email: "another@one.com"}});

  // + Idempotent? Yes.
f.execute({seq: 5, stream_id: "-LL0WL4l6qwaCNndM44l", aggregate: "person", commandString: "update_email", payload: { from: "another@one.com", to: "hehe@hehe.hu", reason: "test"}});

  // + Idempotent? Yes.
f.execute({seq: 5, stream_id: "-LL0WL4l6qwaCNndM44l", aggregate: "person", commandString: "delete_email", payload: {email: "hehe@hehe.hu", reason: "test2"}});

   TEST NAME CHANGE

f.execute({seq: 5, stream_id: "-LL0WL4l6qwaCNndM44l", aggregate: "person", commandString: "change_name", payload: {first_name: "A", last_name: "G", reason: "test2"}});

   TEST GROUPS

f.execute({seq: 5, stream_id: "-LL0WL4l6qwaCNndM44l", aggregate: "person", commandString: "remove_from_group", payload: {group: "listeners", reason: "test"}});

f.execute({seq: 5, stream_id: "-LL0WL4l6qwaCNndM44l", aggregate: "person", commandString: "add_to_group", payload: {group: "listeners"}});

   TEST PHONE
TODO: normalize phone numbers, as those will be the keys!
*/
