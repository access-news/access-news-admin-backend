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
    return ADMIN_APP.database().ref("/streams").push().key;
}

/* "stream_id" is also contained by the event, but I think it is more prudent
   to expose it in here as well. (Especially when seeing the name of the
   function, and `execute()` explicitly requires "stream_id" anyway.)
*/
function append_event_to_stream(stream_id, event) {

    const db = ADMIN_APP.database();
    const event_id = db.ref("event_store").push().key;

    var updates = {};
    updates[`/streams/${stream_id}/${event_id}`] = event;
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

    add_for_multi: function(p) {

        return new Function("event_snapshot", "state",
                `
                const event    = event_snapshot.val();
                const event_id = event_snapshot.ref.getKey();

                // Check if any emails have been added previously
                if (state["${p.attribute}"] === undefined) {
                    state["${p.attribute}"] = {};
                    state["${p.attribute}"][event_id] = event["fields"]["${p.event_field}"];
                } else {
                    var update = {};
                    update[event_id] = event["fields"]["${p.event_field}"];
                    Object.assign(state["${p.attribute}"] , update);
                };

                // Return the mutated state.
                return state;
                `)
    },

    update_for_multi: function(p) {

        return new Function("event_snapshot", "state",
                `
                const event = event_snapshot.val();
                state["${p.attribute}"][event.fields.event_id] = event["fields"]["${p.event_field}"];

                return state;
                `)
    },

    delete_for_multi: function(p) {

        /* "p" here only requires an "attribute" field here (e.g.,
            `{ attribute: "emails" }`), becuase the function will
            delete one value from the attribute.
        */

        return new Function("event_snapshot", "state",
                `
                const event = event_snapshot.val();

                state["${p.attribute}"][event.fields.event_id] = null;

                return state;
                `)
    },
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

    people: {

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
                    required_fields: ['email', 'event_id', 'reason'],
                }),

            "delete_email":
                command_factory({
                    event_name:      'email_deleted',
                    // Technically 'email' is not required, but nice to avoid an extra lookup
                    required_fields: ['email', 'event_id', 'reason']
                }),

            "add_phone_number":
                command_factory({
                    event_name:      'phone_number_added',
                    required_fields: ['phone_number'],
                }),

            "update_phone_number":
                command_factory({
                    event_name:      'phone_number_updated',
                    required_fields: ['phone_number', 'event_id', 'reason'],
                }),

            "delete_phone_number":
                command_factory({
                    event_name:      'phone_number_deleted',
                    // Technically 'phone_number' is not required, but nice to avoid an extra lookup
                    required_fields: ['phone_number', 'event_id', 'reason']
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
                    required_fields: ['group'],
                    constraint:      group_constraint
                }),
        },

        /* Used by `applicator`. These are the actual `apply` functions
           to mutate the state of a specific aggregate instance applying the
           provided event. In `applicator` they are actually called `apply`.
        */
        event_handlers: {

            /* Don't need the previous state, because this command creates a
               brand new instance, so there is nothing to mess up. */
            "person_added":
                function(event_snapshot, state) {

                    state["name"] = event_snapshot.val().fields;

                    return state;
                },

            "person_name_changed":
                function(event_snapshot, state) {
                    const event = event_snapshot.val();
                    // The previous state will be used to build the new state.
                    state["name"] = event.fields;

                    return state;
                },

            "email_added":
                event_handler_factories.add_for_multi({
                    attribute:   "emails",
                    event_field: "email"
                }),

            "email_updated":
                event_handler_factories.update_for_multi({
                    attribute:   "emails",
                    event_field: "email"
                }),

            "email_deleted":
                event_handler_factories.delete_for_multi({
                    attribute: "emails"
                }),

            "phone_number_added":
                event_handler_factories.add_for_multi({
                    attribute:   "phone_numbers",
                    event_field: "phone_number"
                }),

            "phone_number_updated":
                event_handler_factories.update_for_multi({
                    attribute:   "phone_numbers",
                    event_field: "phone_number"
                }),

            "phone_number_deleted":
                event_handler_factories.delete_for_multi({
                    attribute: "phone_numbers"
                }),

            "added_to_group":
                /* The `event_handler_factories.*_for_multi()`  functions are not
                   appropriate  here,  because  there   aren't  many  groups  and
                   therefore do not require unique IDs.
                */
                function(event_snapshot, state) {

                    // The previous state will be used to build the new state.
                    var state   = state;
                    const event = event_snapshot.val();

                    if (state["groups"] === undefined) {
                        state["groups"] = {};
                    };

                    const group_name = event["fields"]["group"];
                    state["groups"][group_name] = true;

                    // Return the mutated state.
                    return state;
                },

            "removed_from_group":
                function(event_snapshot, state) {

                    var state   = state;
                    const event = event_snapshot.val();

                    /* Just as in "added_to_group", membership is not
                       checked here. That should be done before we
                       get here.
                    */
                    const group_name = event["fields"]["group"];
                    state["groups"][group_name] = null;

                    return state;
                },
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

    // Fetch previous state.
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

                    const event_id = event_snapshot.ref.getKey();

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
                    const state         = state_store[stream_id];
                    const event_handler = aggregates[event.aggregate]["event_handlers"][event.event_name];

                    if ( event.seq <= state.seq ) {
                        console.log(`${stream_id} ${event_id} no op  (${event.seq}, ${state.seq}) ${event.event_name}` );
                        return;
                    } else {
                        console.log(`${stream_id} ${event_id} replay (${event.seq}, ${state.seq}) ${event.event_name}` );

                        state["seq"] = event.seq;

                        var next_state = event_handler(event_snapshot, state);

                        Object.assign(state, next_state);
                        ADMIN_APP.database().ref("/state_store").child(stream_id).update(state);
                    }
                }
            );
        }
    )
}

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
    /* USER_ID = PEOPLE INSTANCE (i.e., person) STREAM_ID

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
                aggregate: "people",
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
               aggregate: "people",
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
var f = require('./admin-functions.js');
f.execute({seq: 1, stream_id: f.create_new_stream_id(), aggregate: "people", commandString: "add_person", payload: { first_name: "El", last_name: "Rodeo" }});
f.execute({seq: 1, stream_id: f.create_new_stream_id(), aggregate: "people", commandString: "add_person", payload: { first_name: "Al", last_name: "Varo" }});

var elrodeo = "-LK46YVGQg8e6Hw3DNmH";
f.execute({seq: 2, stream_id: elrodeo, aggregate: "people", commandString: "add_email", payload: { email: "el@rod.eo" }});
f.execute({seq: 3, stream_id: elrodeo, aggregate: "people", commandString: "add_email", payload: { email: "meg@egy.com" }});

var alvaro  = "-LK46YVkhW90tzL1JP8C";
f.execute({seq: 2, stream_id: alvaro, aggregate: "people", commandString: "add_phone_number", payload: {phone_number: "112"}});

f.execute({seq: 4, stream_id: elrodeo, aggregate: "people", commandString: "add_phone_number", payload: {phone_number: "777"}});

// TESTING ADDING AND REMOVING GROUPS
f.execute({seq: 5, stream_id: elrodeo, aggregate: "people", commandString: "add_to_group", payload: {group: "admins"}});
f.execute({seq: 6, stream_id: elrodeo, aggregate: "people", commandString: "remove_from_group", payload: {group: "admins"}});

var elrodeos_emailid = "-LK46kHf06abiUK5-W81";
f.execute({seq: 7, stream_id: elrodeo, aggregate: "people", commandString: "update_email", payload: { email: "EL@ROD.EO", event_id: elrodeos_emailid, reason: "testing"}});

var alvaros_phone_id = "-LK46uHvLbPskBIMMiM8";
f.execute({seq: 3, stream_id: alvaro, aggregate: "people", commandString: "update_phone_number", payload: { phone_number: "456", event_id: alvaros_phone_id, reason: "testing"}});

f.execute({seq: 4, stream_id: alvaro, aggregate: "people", commandString: "add_to_group", payload: {group: "admins"}});

f.execute({seq: 8, stream_id: elrodeo, aggregate: "people", commandString: "add_to_group", payload: {group: "admins"}});
f.execute({seq: 9, stream_id: elrodeo, aggregate: "people", commandString: "add_to_group", payload: {group: "listeners"}});
*/

// f.public_commands.add_user({first_name: "Attila", last_name: "Gulyas", username: "toraritte", email: "agulyas@societyfortheblind.org", account_types: ["admin", "reader", "listener"]})

