'use strict'

/* SETUP

   https://medium.com/scientific-breakthrough-of-the-afternoon/sending-password-reset-email-after-user-has-been-created-with-firebase-admin-sdk-node-js-1998a2c6eecf
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

function init_firebase_client() {

    const firebase_client = require('firebase');
    const config = require('./firebase_client_config.json');
    firebase_client.initializeApp(config);

    return firebase_client;
};

var FIREBASE_APP = init_firebase_admin();

/* ADMIN COMMANDS */

/* 0. Event creation helpers */

/* General structure of events:

                                    ----- event object ------
    event_store/stream_id/event_id/{event_name,...fields...},timestamp,version,seq

    stream_id: unique identifier of the aggregate instance (such as user_id,
                category_id etc.). Basically an entity that should have its
                own identity in the system.

                For example, categories and publications have their own streams,
                as we need to track them, even if a publication has no content
                (i.e., recordings) yet. Groups on the other hand are tracked
                with a person's stream because they always have users, and
                introducing a new group should have a purpose, and therefore
                initial users.

                Ignored, when seq===0

    seq: "expected_version" in other event store implementations, but I
            think that name is misleading, especially if one tries to version
            their events. It is a sequential number for every event in the
            stream that, denoting chronological sequence.

            Calling the function with seq===0 implies the start of a new stream.
*/

/* DROPPING SEQ (may regret it soon after)

    I don't really know how to enqueue events headed to the store to enforce
    order, but every event has a push ID (client side date) and a server
    timestamp. These are not infallible though, so I will plan for best effort
    for now.
*/

var EVENT_VERSION = 0;

function create_new_stream_id() {
    return FIREBASE_APP.database().ref("/streams").push().key;
}

/* ISSUE #2
   Function name is misleading because it also saves events to
   `/events`. Wanted to use the `Reference.update()` transaction,
   hence the reason why didn't just create another function.

   Another option would've been to add it to apply, but this is
   the right place to put it logically, when the event is created
   in `execute()`.
*/
function append_event_to_stream(event) {

    /* For my future self: "stream_id" is added to the event,
       when the event is created in `Factories.command`.
    */
    const db = FIREBASE_APP.database();
    const event_id = db.ref("event_store").push().key;

    var updates = {};
    updates[`/streams/${event.stream_id}/${event_id}`] = event;
    updates[`/event_store/${event_id}`] = event;

    return db.ref().update(updates);
};

/* Generate meaningful errors */
function verify_payload_fields(o) {

    /* {
           required_fields: [ "prop1", ..., "propN"],
           payload:         { field: "val", ... }
       }
    */

    var fields = {};

    const payload_properties = Object.keys(o.payload);

    if (payload_properties.length !== o.required_fields.length) {
        throw `Expected fields: ${o.required_fields}, got: ${payload_properties}`
    }

    for (var i in payload_properties) {

        const payload_prop = payload_properties[i];

        if (o.required_fields.includes(payload_prop) === false) {
            throw `Required fields ${o.required_fields} do not match ${payload_prop}`
        }

        fields[payload_prop] = o.payload[payload_prop];
    }

    return fields;
}

/* 1. Aggregate and helpers */

const factories = {

    event_handlers: {

        /* Factories with "multi" in their name are for attributes (value objects
        in DDD?), that can have multiple values simultaneously. For example,
        a person can have multiple email addresses, phone numbers etc. These
        require extra checks than singular ones, for example a person's name,
        where changing it simply overwrites the current value.
        */

        add_for_multi: function(o) {
            /* o =
                {
                    state_attribute: "emails", // state: aggregate instance's state
                    event_field:     "email"
                }
            */

            return new Function("event_snapshot", "stream_state",
                    `
                    const event    = event_snapshot.val();
                    const event_id = event_snapshot.ref.getKey();

                    // The current state will be used to build the next state.
                    var state    = stream_state;

                    // Check if any emails have been added previously
                    if (state["${o.state_attribute}"] === undefined) {
                        state["${o.state_attribute}"] = {};
                        state["${o.state_attribute}"][event_id] = event["fields"]["${o.event_field}"];
                    } else {
                        var update = {};
                        update[event_id] = event["fields"]["${o.event_field}"];
                        Object.assign(state["${o.state_attribute}"] , update);
                    };

                    // Return the mutated state.
                    return state;
                    `)
        },

        update_for_multi: function(o) { /* See `o`'s description at `add_for_multi` */

            return new Function("event_snapshot", "stream_state",
                    `
                    const event = event_snapshot.val();
                    var   state = stream_state;

                    state["${o.state_attribute}"][event.fields.event_id] = event["fields"]["${o.event_field}"];

                    return state;
                    `)
        },

        delete_for_multi: function(o) { /* See `o`'s description at `add_for_multi` */

            /* o = { state_attribute: "emails" } */

            return new Function("event_snapshot", "stream_state",
                    `
                    const event = event_snapshot.val();
                    var   state = stream_state;

                    state["${o.state_attribute}"][event.fields.event_id] = null;

                    return state;
                    `)
        },
    },

    command: function(params) {
        /* p =
            {
                event_name:      'email_added',
                required_fields: ['email'],
            }
        */

        return function(state, p) {

            /* The `p` object is handed down from execute:
                {
                    stream_id:     "stream_id",
                    aggregate:     "people",
                    commandString: "person_added",
                    payload:       { last_name: "Al", first_name:  "Varo"},
                    callback:      extra_logic // function for extra constraints in the command
                }
            */

            const fields =
                verify_payload_fields(
                    {
                        "required_fields": params.required_fields,
                        "payload": p.payload
                    },
                );

            /* The "callback" parameter is to include any logic that
                needs to be enforced, and either throw error(s) or
                create the appropriate event.

                If none is provided, it will simple return the "fields"
                parameter unchanged.
            */
            if (p.callback === undefined) {
                p.callback = function(state, fields) { return fields };
            }

            const event =
                {
                    "aggregate":  p.aggregate,
                    "event_name": params.event_name,
                    "fields":     p.callback(state, fields),
                    "timestamp":  FIREBASE_APP.database.ServerValue.TIMESTAMP,
                    "stream_id":  p.stream_id,
                    "version":    EVENT_VERSION
                }

            return event;
        };
    },

};

const aggregates = {

        /* `new_instance()` only creates the initial state object to be fed
           to `execute()`. The latter will generate an EVENT in turn, saves
           it to the EVENT_STORE. This will trigger the appropriate `apply()`
           function, corresponding to the EVENT TYPE, generate the NEXT STATE,
           and update the STATE_STORE (both in DB and in memory).

           (The "current_state" in `execute()` is only used for getting the
            aggregate type and stream_id, at least for now. It should be the
            place to enforce business/domain rules. This is still a gray area
            for me, but the UI/API would/should take care of this part. For
            example, in order to avoid duplicate emails/phones/etc for a user,
            make the UI so that the user sees that the current values first,
            and checks can be included there too.)

           ```
                                                   ____________
                                                  /            \
                                                 |              |
                                                 V              |
                                              ___ _             |
                                             /     \            |
           aggregates.<type>.( new_instance | look_up )         |
           |          _________/                /     |         |
           |         /                         /      |         |
           |     NEW_STATE                    /       |         |
           |      |    |                     /        |         |
           |      V    |                    /         |         |
           |    STATE  |              STATE_STORE     |         |
           |    STORE  |                /             |         |
           |           |       ________/              |         |
           |            \     /                       |         |
           |             \   /                        |         |
           \______________\ /_________________________/         |
                           |                                    |
                           |                                    |
                           V                                    |
           execute( current_state, COMMAND )                    |
           \_____________________   ______/                     |
                                  |                             |
                                  V                             |
                                EVENT                           |
                                  |                             |
                                  V                             |
                             EVENT_STORE                        |
                                  |                             |
                                  V                             |
                            `on()` LISTENER                     |
                                  |                             |
                                  V                             |
           apply( current_state, EVENT )                        |
           \___________   ____________/                         |
                        |                                       |
                        |                                       |
                        V                                       |
                    NEXT_STATE                                  |
                        |                                       |
                        V                                       |
                   STATE_STORE (in-memory)                      |
                        |                                       |
                        V                                       |
                   /STATE (Firebase Realtime DB)                |
                        |                                       |
                        |_______________________________________|
        */

    people: {

        /* Why the stream_id shouldn't be mentioned here and why `create_new_stream_id()`
           should also be invoked somewhere else.
           ==========================================================================
           This function only provides a state stub for an aggregate instance to get
           things going.

           In `execute()`s, when no "stream_id" is supplied, it means that it will
           kick off a brand new stream, and the STATE_STORE also has no entry for
           that stream's state. The aggregate-specific `execute()`s will take care
           of creating a new "stream_id" in these cases, but to get to the first
           event, this very basic object needs to be set up: `apply()` is aggregate
           agnostic thus it will need some info on the context to invoke the right
           event handlers, such as

            + the aggregate type the event belongs to or

            + the timestamp,
        */

        // Use commands to store domain/business logic (i.e., to enforce them).
        commands: {

            "add_person":
                factories.command({
                    event_name:      'person_added',
                    required_fields: ['first_name', 'last_name']
                }),

            "change_name":
                factories.command({
                    event_name:      'person_name_changed',
                    required_fields: ['first_name', 'last_name', 'reason']
                }),

            "add_email":
                factories.command({
                    event_name:      'email_added',
                    required_fields: ['email'],
                }),

            "update_email":
                factories.command({
                    event_name:      'email_updated',
                    required_fields: ['email', 'event_id', 'reason'],
                }),

            "delete_email":
                factories.command({
                    event_name:      'email_deleted',
                    // Technically 'email' is not required, but nice to avoid an extra lookup
                    required_fields: ['email', 'event_id', 'reason']
                }),

            "add_phone_number":
                factories.command({
                    event_name:      'phone_number_added',
                    required_fields: ['phone_number'],
                }),

            "update_phone_number":
                factories.command({
                    event_name:      'phone_number_updated',
                    required_fields: ['phone_number', 'event_id', 'reason'],
                }),

            "delete_phone_number":
                factories.command({
                    event_name:      'phone_number_deleted',
                    // Technically 'phone_number' is not required, but nice to avoid an extra lookup
                    required_fields: ['phone_number', 'event_id', 'reason']
                }),

            /* TODO (?): "event_name" could be a template closure to allow
                         dynamic event creation. For example, based on the
                         "group" field, the event could be "added_to_admins",
                         "added_to_listeners" etc.

                         But then again, too much magic can be harmful. This
                         way we know exactly that group membership has been
                         granted.

                         Also, similar commands could also be refactored
                         (such as "add_email", "update_email", "delete_email"
                         and friends). But the deeper we go, the more the
                         code will loose its self documenting properties.
            */
            "add_to_group":
                factories.command({
                    event_name:      "added_to_group",
                    required_fields: ['group'] // 'user_id' omitted as it is the stream_id for now
                }),

            "remove_from_group":
                factories.command({
                    event_name:      "removed_from_group",
                    required_fields: ['group']
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
                function(event_snapshot) {
                    return { "name": event_snapshot.val().fields };
                },

            "person_name_changed":
                function(event_snapshot, instance_state_object) {
                    const event    = event_snapshot.val();
                    // The previous state will be used to build the new state.
                    var state    = instance_state_object;
                    state["name"] = event.fields;

                    return state;
                },

            "email_added":
                factories.event_handlers.add_for_multi({
                    state_attribute: "emails",
                    event_field:     "email"
                }),

            "email_updated":
                factories.event_handlers.update_for_multi({
                    state_attribute: "emails",
                    event_field:     "email"
                }),

            "email_deleted":
                factories.event_handlers.delete_for_multi({
                    state_attribute: "emails"
                }),

            "phone_number_added":
                factories.event_handlers.add_for_multi({
                    state_attribute: "phone_numbers",
                    event_field:     "phone_number"
                }),

            "phone_number_updated":
                factories.event_handlers.update_for_multi({
                    state_attribute: "phone_numbers",
                    event_field:     "phone_number"
                }),

            "phone_number_deleted":
                factories.event_handlers.delete_for_multi({
                    state_attribute: "phone_numbers"
                }),

            "added_to_group":
                /* The `this.factories.event_handlers.*_for_multi()` functions
                   are not appropriate here, because there aren't many groups
                   and these could be just added as a list (which is tricky with
                   Firebase's Realtime DB).

                   It could be that the same phone number belong to multiple
                   people, but using a `push()` ID they are unique values that can
                   be traced back to individuals.

                   On the other hand, a projection can be built to track how many
                   people are using the same contact details (i.e., same address,
                   same phone number, email, etc.).

                   There may be a pattern emerging later, but leaving this as is
                   until then.
                */
                function(event_snapshot, instance_state_object) {

                    // The previous state will be used to build the new state.
                    var state   = instance_state_object;
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
                function(event_snapshot, instance_state_object) {

                    var state   = instance_state_object;
                    const event = event_snapshot.val();

                    /* Just as in "added_to_group", membership is not checked here.
                       That should be done before we get here. */
                    const group_name = event["fields"]["group"];
                    state["groups"][group_name] = null;

                    return state;
                },
        },

    },
};

/* Trying to justify the current architecture, where the concerns are nicely
    separated:

        * `execute()` only creates the events and touches the EVENT_STORE
        * `apply()`   only creates the next state and writes to the STATE_STORE

    Chaining the two functions together and skipping the messy event handler
    stuff, but there would be downsides too.

    For example, with the current implementation, commands cannot arbitrarily
    be chained together and state cannot be rolled forward, because `execute()`
    does not mutate state and `apply()` only reacts to event notifications
    once `execute()` writes the resulting events into the EVENT_STORE.
    Logically, there also wouldn't make any sense to group "add_email" and
    "delete_person" for example.

    Yes, race conditions are always a concern, but command idempotency helps
    in this field. For example, multiple admins want to delete that same
    obsolete email for a user, submit a command, and all succeed: the
    EVENT_STORE records all attempts, and applying the first event will
    update the state, but the rest will reinforce the same truth only.

    This is also only a module, some constraints needs to enforced by the
    UI/API and try to prevent the users to shoot themselves in the leg.

    -------------------------------------------------------------------

    So this is the theory to prevent a massive rewrite, and we'll so
    how much is delusion and "sober peasant mind".
*/
function execute(p) {

    /* p =
        {
            stream_id:     "stream_id",
            aggregate:     "people",
            commandString: "person_added",
            payload:       { last_name: "Al", first_name:  "Varo"},
            callback:      extra_logic // function for extra constraints in the command
        }
    */

    const command = aggregates[p.aggregate]["commands"][p.commandString];

    if (command === undefined) {
        throw `No ${commandString} in ${p.aggregate} aggregate.
                Choose one from ${Object.keys(aggregates[p.aggregate]["commands"])}`;
    }

    /* Defined with `const` because `execute()` only uses the state
        to inspect it in order to make decisions on what to put in
        the generated events, but will never mutate it.
    */
    const state = (state_store[p.stream_id] !== undefined) ? state_store[p.stream_id] : {};

    const event = command(state, p);

    return append_event_to_stream(event);
};

var state_store = {};

/* TODO: outdated
   Purpose: (0) Rebuild in-memory ("state_store") and "/state" DB state
                on server restart.
            (1) Attach a listener to 'event_store', that will
            (2) attach a listener to each stream_id to listen to
                new events.

         When a new stream is started, (1) will attach a listener
         to it, listening to new events within the stream. When a
         new event comes in, it will be `apply`ed (i.e., projections
         updated).

         event_store
             -LJ16Q8UiM6eJWyesqGO (stream) -> attach new listener to new child
                 -LJ16Q8XDTfk0Z_r14EA (event) -> listener projects the data
                 -LJ282RXV-TCLxxOh-xS (event)
             -LJ2F09G2M_YWB78BNo_ (stream)
                 -LJ2F09KfLTSKOXf7vlN (event)
                 -LJ2NVlbYvz9ptVpiCkj (event)
                 -LJ2OL1NZEQBpiA_mPDh (event)
                 -LJ2TkQjSfhV39SXWoDh (event)
*/
function apply() {

    // Fetch previous state.
    FIREBASE_APP.database().ref("/state").once("value").then(
        function(state_snapshot){

            const there_is_state_in_DB = (state_snapshot.val() !== null);

            if (there_is_state_in_DB === true) {
                state_store = Object.assign(state_store, state_snapshot.val());
            }

            /* Otherwise "state_store" remains {}.*/
        }
    ).then(

        /* "initial_state" refers to the state after a server restart.
           Used by `applicator()` to replay events in the correct order
           by comparing timestamps: if the about to be applied event
           is older, it is applied before the "fetch state" phase
           (i.e., `ref('/state').once(...)`, see issue #1) and returns
           early. */
        function() {

            const event_store = FIREBASE_APP.database().ref("/event_store");

            event_store.on(
                'child_added',
                function(event_snapshot) {

                    const event = event_snapshot.val();
                    const stream_id = event.stream_id;

                    const event_id = event_snapshot.ref.getKey();

                    console.log(event_id);
                    console.log(stream_id);
                    /* Get the event handler that should be used with the
                        current event.

                    const event_handler =
                        aggregates[event.aggregate]["event_handlers"][event.event_name];

                        There shouldn't be any errors because event names are assigned
                        to commands whenever they are created, and they are never supplied
                        by hand.

                    const event_handlers = aggregates[event.aggregate]["event_handlers"];

                    var event_handler;
                    if ( event_handlers[event.event_name] !== undefined ) {
                        event_handler = event_handlers[event.event_name];
                    } else {
                        const event_handler_keys = Object.keys(event_handlers);
                        throw `No such event handler. Choose from the list: ${event_handler_keys}`
                    };
                    */

                    /* (this should go somewhere else, probably to aggregate under
                        the diagram)
                        WALKTHROUGH
                        On creating a new aggregate instance (i.e. a stream),
                        the next state provided by `apply()` will need a
                        place to live. (Remember, `execute(state, command)`
                        only writes to the EVENT_STORE, and `apply(state, event)`
                        to the STATE_STORE!)

                        Example:

                        ```
                            // ! Also adds a new entry to STATE_STORE !
                            const new_person = aggregates.people.new_instance();
                            //       |
                            //       `-> {
                            //               aggregate: 'people',
                            //               stream_id: create_new_stream_id(), // -> new stream_id
                            //               timestamp: 0
                            //           };
                            execute(
                    */

                    if (state_store[stream_id] === undefined) {
                    /* Two cases when we can end up here:

                        1. "/state" in DB is missing entirely, therefore condition will return
                        `false` for every `stream_id`.

                        2. The server was down while a new stream was started in the EVENT_STORE,
                        therefore no listener was active to handle it, and events are flooding
                        in upon restart.

                        To jump start this process, a very minimal state-stub has to be supplied
                        to allow applying events on top.

                        The "aggregate"  attribute is  not queried  past this  point, but  it is
                        needed. The  `aggregates.<type>.event_handlers` are only  concerned with
                        the event's  "fields" object,  and the generated  "stream_next_state" is
                        simply merged with the current state (adding or overwriting attributes).
                        When the next event is fed  to `apply()`, it would query the "aggregate"
                        attribute above, and if missing,  it would yield `undefined` when trying
                        to find the right event handler, crashing the process.
                    */
                        state_store[stream_id] =
                            {
                                aggregate: event.aggregate,
                                timestamp: event.timestamp
                            };

                    }

                    const stream_state  = state_store[stream_id];
                    const stream_state_timestamp = stream_state.timestamp;

                    const event_handler = aggregates[event.aggregate]["event_handlers"][event.event_name];

                    /* Comparing  the events'  and  the states'  timestamps,  to check  whether
                    events come in  in order, is unnecessary for reasons  below, but keeping
                    it, becuase if there is some state in the DB, the already applied events
                    can be just skipped.

                    + End  user  public functions  (such  as  `add_user()`) should  chain
                        commands in a way that ensures the order (i.e., promise chaining of
                        `append_event_to_stream()`).

                    + Each event has the stream_id, and if there is no stream, it will be
                        created by the check above.  For example, should events "add_email"
                        and "add_person" arrive  in this order, it wouldn't  cause an issue
                        (right?) as  a state-stup would be  created for the email,  and the
                        "add_person" event would be applied on top of it.
                    */
                    if (event.timestamp < stream_state_timestamp) {
                        console.log(`${event.event_name} ${event_id} - do nothing` );
                    } else {
                        console.log(`${event.event_name} ${event_id} - replay event and return` );

                        var stream_next_state = event_handler(event_snapshot, stream_state);
                        stream_next_state["timestamp"] = event.timestamp;

                        Object.assign(stream_state, stream_next_state);
                        FIREBASE_APP.database().ref("/state").child(stream_id).update(stream_state);
                    }
                }
            );
        }
    )
}
apply();

/* The rationale behind creating this collection is twofold:

     + TECHNICAL: Firebase commands are asynchronous, and they return promises,
       thus in order to do something on success, the actions need to be wrapped
       in it (i.e., in `then()` for example). So in order to save the resulting
       "user_id", the database commands need to be run in the callback.

     + AESTHETICAL (not the right word, but working on it): these functions
       would be called by end users (admins mostly) and would emit multiple
       events. (Whereas `execute()` and `apply()` work on one command and event
       respectively.)
*/
const public_commands = {

    /* person =
       {
           (REQUIRED) first_name: "",
           (REQUIRED) last_name:  "",
                      username:   "", // "first_name" + "last_name" by default
       ??? (REQUIRED) user_id:    "", // i.e., person stream_id
           (REQUIRED) email:      "",
                      address:    "",
                      phone_number: "",
           (REQUIRED) account_type: [ "admin" | "reader" | "listener" ],
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
    add_user: function(p) {

        /* THIS ALSO CREATES AN ENTRY IN THE -> STATE_STORE <-

           (Unfortunately the shouting is necessary because
           I am an idiot and keep forgetting my own solutions.
           Almost made a convoluted workaround carrying state
           that has already been solved just this morning.)
        */
        const person = aggregates.people.new_instance();

        // TODO create a function for optional parameter checks
        if (p.username === undefined) {
            p["username"] = `${p.first_name} ${p.last_name}`;
        }
                                                   // TODO
        FIREBASE_APP.auth().createUser(            // move
            {                                      // this
                "disabled":     false,             // to
                "displayName":  p.username,        // the
                "email":        p.email,           // end
                "phoneNumber":  p.phone_number,    //  |
                "uid":          person.stream_id   //  |
            }                                      //  |
        ).then(
            function(user_record) {

                // /*
                // TODO these do need to go into a promise.
                // TODO do make a "macro" with `Function`. Use `Array.reduce()`
                //      where the initial element is the first command in string
                //      so that the rest can be just chained.
                const commands =
                    [
                        {
                            command: "add_person",
                            payload: {
                                "first_name": p.first_name,
                                "last_name":  p.last_name
                            }
                        },
                        {
                            command: "add_email",
                            payload: { "email": p.email }
                        },
                        {
                            command: "add_phone_number",
                            payload: { "phone_number": p.phone_number }
                        },
                        {
                            command: "add_to_group",
                            payload: { "group": `${p.account_type}s` }
                        },
                    ]

                commands.forEach(
                    function(command) {
                        execute(person, command);
                    }
                );

                /* To promise chain compatible commands together and synchronize writes to the DB.
                   This way events write order would be ensured, as the next write only happens if
                   the previous one was successful.

                   aggregates.people.execute(stream_id, commandString_1, payload_1).then(
                       function() {
                           return aggregates.people.execute(stream_id, commandString_2, payload_2);
                       }.then(
                           function() {
                               return aggregates.people.execute(stream_id, commandString_2, payload_2);
                            }
                       ).then(...)
                */

                // */
                /* New commands can be added as needed.

                   "person" is added to each subsequent iteration because only
                   the stream_id and the aggregate type is needed. */
                /*
                execute(
                    person,
                    {
                        command: "add_person",
                        payload: {
                            "first_name": p.first_name,
                            "last_name":  p.last_name
                        }
                    }).then(
                        function() {
                            return execute(
                                person,
                                {
                                    command: "add_email",
                                    payload: { "email": p.email }
                                });
                        }
                    ).then(
                        function() {
                            return execute(
                                person,
                                {
                                    command: "add_phone_number",
                                    payload: { "phone_number": p.phone_number }
                                });
                        }
                    ).then(
                        function() {
                            return execute(
                                person,
                                {
                                    command: "add_to_group",
                                    payload: { "group": `${p.account_type}s` }
                                });
                        }
                    );
                    */
            }
        );
    }
}

/* firebase_admin.auth().createUser({ email: person.email }).then(function(userRecord) {

        const db = firebase_admin.database();
        const people_ref = db.ref("event_store");
        const timestamp = firebase_admin.database.ServerValue.TIMESTAMP;

         // If user creation is successful, save "person_added" event, ...

        store_event(
            people_ref,
            "person_added",
            {
                "user_id": userRecord.uid,
                "name": {
                    "first": person.name.first,
                    "last":  person.name.last
                }
            },
            timestamp,
            0

        ).then(function(_ref) {

            //  ... save "person_email_added" after above event finishes, and ...

            store_event(
                people_ref,
                "person_email_added",
                {
                    "user_id": userRecord.uid,
                    "value":   person.email
                },
                timestamp,
                0
            )
        }).then(function(_ref) {

            //  ... finally store the "<account>_added" event.

            const account_event = account_type + "_added";

            store_event(
                db.ref("event_store"),
                account_event,
                {
                    "user_id":  userRecord.uid,
                    "username": person.email
                },
                timestamp,
                0
            );
        }).catch(function(error) { console.log(error) });

        firebase_client.auth().sendPasswordResetEmail(person.email);
    });
};
*/

module.exports = {
    init_firebase_admin,
    init_firebase_client,
    create_new_stream_id,
    verify_payload_fields,
    append_event_to_stream,
    EVENT_VERSION,
    FIREBASE_APP,
    aggregates,
    execute,
    apply,
    state_store,
    public_commands
};

/*
var f = require('./admin-functions.js');
f.execute({stream_id: f.create_new_stream_id(), aggregate: "people", commandString: "add_person", payload: { first_name: "El", last_name: "Rodeo" }});
f.execute({stream_id: f.create_new_stream_id(), aggregate: "people", commandString: "add_person", payload: { first_name: "Al", last_name: "Varo" }});


var elrodeos_streamid = "-LJpRoUFK7b8czjQqckN";
var alvaros_streamid  = "-LJpS1bCV8-cMftgz87w";
f.execute({stream_id: elrodeos_streamid, aggregate: "people", commandString: "add_email", payload: { email: "el@rod.eo" }});
f.execute({stream_id: elrodeos_streamid, aggregate: "people", commandString: "add_phone_number", payload: {phone_number: "777"}});
f.execute({stream_id: alvaros_streamid, aggregate: "people", commandString: "add_phone_number", payload: {phone_number: "111"}});

var elrodeos_emailid = "-LJpRoUIP0SZMgmaJ3As";
f.execute({stream_id: elrodeos_streamid, aggregate: "people", commandString: "update_email", payload: { email: "el@rod.eo", event_id: elrodeos_emailid, reason: "testing"}});
*/
