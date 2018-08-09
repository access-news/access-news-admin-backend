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

function create_new_stream() {
    return FIREBASE_APP.database().ref("event_store").push().key;
}

/* ISSUE #2
   Function name is misleading because it also saves events to
   `/events`. Wanted to use the `Reference.update()` transaction,
   hence the reason why didn't just create another function.

   Another option would've been to add it to apply, but this is
   the right place to put it logically, when the event is created
   in `execute()`.
*/
function append_event_to_stream(stream_id, event) {

    const db = FIREBASE_APP.database();
    const event_id = db.ref("event_store").child(stream_id).push().key;

    // This one is needed to look up the the right aggregate when fetching
    // events from `/events`.
    event["stream_id"] = stream_id;

    var updates = {};
    updates[`/event_store/${stream_id}/${event_id}`] = event;
    updates[`/events/${event_id}`] = event;

    db.ref().update(updates);
};

/* NOTE: Event fields need to be one-dimensonal (-> easier to check
         in `cast_event_payload()` below).*/
function create_event(o) {

    /*  {
            "aggregate_type":  aggregate_type,
            "event_name": c.event_name,
            "fields":     fields,
            "timestamp":  FIREBASE_APP.database.ServerValue.TIMESTAMP,
            "version":    EVENT_VERSION
        }

    `fields` parameter is the payload, after being casted

    */

    var event = {
        "aggregate":  o.aggregate_type,
        "event_name": o.event_name,
        "fields":     o.fields,
        "timestamp":  FIREBASE_APP.database.ServerValue.TIMESTAMP,
        "version":    o.version
    }

    return event;
}

/* Generate meaningful errors */
function cast_event_payload(o) {

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

const apply_factories = {

    /* Factories with "multi" in their name are for attributes (value objects
       in DDD?), that can have multiple values simultaneously. For example,
       a person can have multiple email addresses, phone numbers etc. These
       require extra checks than singular ones, for example a person's name,
       where changing it simply overwrites the previous value.
    */

    add_for_multi: function(o) {
        /* o =
               {
                   state_attribute: "emails", // state: aggregate instance's state
                   event_field:     "email"
               }
        */

        return new Function("event_snapshot", "instance_state_object",
                `
                const event    = event_snapshot.val();
                const event_id = event_snapshot.ref.getKey();

                // The previous state will be used to build the new state.
                var state    = instance_state_object;

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

        return new Function("event_snapshot", "instance_state_object",
                `
                const event = event_snapshot.val();
                var   state = instance_state_object;

                state["${o.state_attribute}"][event.fields.event_id] = event["fields"]["${o.event_field}"];

                return state;
                `)
    },

    delete_for_multi: function(o) { /* See `o`'s description at `add_for_multi` */

        /* o = { state_attribute: "emails" } */

        return new Function("event_snapshot", "instance_state_object",
                `
                const event = event_snapshot.val();
                var   state = instance_state_object;

                state["${o.state_attribute}"][event.fields.event_id] = null;

                return state;
                `)
    },
};

const aggregates = {

    people: {

        new_instance: function() {

            function Person() {
                this.type = 'people';
            }
            return new Person();
        },

        commands: {
            "add_person": {
                event_name:      'person_added',
                required_fields: ['first_name', 'last_name'],
            },

            "change_name": {
                event_name:      'person_name_changed',
                required_fields: ['first_name', 'last_name']
            },

            "add_email": {
                event_name:      'email_added',
                required_fields: ['email'],
            },

            "update_email": {
                event_name:      'email_updated',
                required_fields: ['email', 'event_id'],
            },

            "delete_email": {
                event_name:      'email_deleted',
                // Technically 'email' is not required, but nice to avoid an extra lookup
                required_fields: ['email', 'event_id', 'reason']
            },

            "add_phone_number": {
                event_name:      'phone_number_added',
                required_fields: ['phone_number'],
            },

            "update_phone_number": {
                event_name:      'phone_number_updated',
                required_fields: ['phone_number', 'event_id'],
            },

            "delete_phone_number": {
                event_name:      'phone_number_deleted',
                // Technically 'phone_number' is not required, but nice to avoid an extra lookup
                required_fields: ['phone_number', 'event_id', 'reason']
            },

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
            "add_to_group": {
                event_name:      "added_to_group",
                required_fields: ['group'] // 'user_id' omitted as it is the stream_id for now
            },

            "remove_from_group": {
                event_name:      "removed_from_group",
                required_fields: ['group']
            },
        },

        /* Used by `applicator`. These are the actual `apply` functions
           to mutate the state of a specifig aggregate instance applying the
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
                apply_factories.add_for_multi({
                    state_attribute: "emails",
                    event_field:     "email"
                }),

            "email_updated":
                apply_factories.update_for_multi({
                    state_attribute: "emails",
                    event_field:     "email"
                }),

            "email_deleted":
                apply_factories.delete_for_multi({
                    state_attribute: "emails"
                }),

            "phone_number_added":
                apply_factories.add_for_multi({
                    state_attribute: "phone_numbers",
                    event_field:     "phone_number"
                }),

            "phone_number_updated":
                apply_factories.update_for_multi({
                    state_attribute: "phone_numbers",
                    event_field:     "phone_number"
                }),

            "phone_number_deleted":
                apply_factories.delete_for_multi({
                    state_attribute: "phone_numbers"
                }),

            "added_to_group":
                /* The `apply_factories.*_for_multi()` functions are not appropriate
                   here, because there aren't many groups and these could be just
                   added as a list (which is tricky with Firebase's Realtime DB).

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
        }
    },
};

/* aggregate_instance = object holding current state; ignored for new stream

   p =  {
           (REQUIRED) command: string_from_aggregates_commands,
           (REQUIRED) payload: object_conforming_to_command_in_aggregates,
                      callback: function // no use for it so far
        }
*/
function execute(aggregate_instance, p) {


    if (p.callback) {
        p.callback();
    }

    /* TODO: add some extra checks on what commands should trigger
             the creation of a new stream. There should only be one
             per aggregate.

             Or push this to the UI/API as well?
    */
    const is_stream_new = (aggregate_instance.stream_id === undefined);
    const stream_id = (is_stream_new) ? create_new_stream() : aggregate_instance.stream_id;

    const aggregate_type = aggregate_instance.type;
    const c = aggregates[aggregate_type]["commands"][p.command];

    if (c === undefined) {
        throw `command "${p.command}" does not exist`;
    }

    const fields =
        cast_event_payload(
            {
                "required_fields": c.required_fields,
                "payload":         p.payload
            }
        );

    const event =
        create_event(
            {
                "aggregate_type":  aggregate_type,
                "event_name": c.event_name,
                "fields":     fields,
                "timestamp":  FIREBASE_APP.database.ServerValue.TIMESTAMP,
                "version":    EVENT_VERSION
            }
        );

    append_event_to_stream(stream_id, event);
}

var state_store = {};

function rebuild_state() {

    // Fetch previous state.
    const db = FIREBASE_APP.database();

    db.ref("/state").once("value").then(
        function(state_snapshot){

            state_store =
                (state_snapshot.val() === null)
                ? state_store 
                : Object.assign(state_store, state_snapshot.val())
        }
    ).then(

        /* "initial_state" refers to the state after a server restart.
           Used by `applicator()` to replay events in the correct order
           by comparing timestamps: if the about to be applied event
           is older, it is applied before the "fetch state" phase
           (i.e., `ref('/state').once(...)`, see issue #1) and returns
           early. */
        function() {

            db.ref('event_store').once('value').then(

                function(snapshot){

                    const store = snapshot.val();
                    const stream_ids = Object.keys(store);

                    stream_ids.forEach(
                        function(stream_id) {

                            const stream = store[stream_id];
                            const event_ids = Object.keys(stream);

                            event_ids.forEach(
                                function(event_id) {

                                    // const stream_id = event_snapshot.ref.getParent().getKey();

                                    const event_snapshot = snapshot.child(stream_id).child(event_id);
                                    const event = event_snapshot.val();

                                    const aggregate = event.aggregate;

                                    /* Get the `apply` function that should be
                                       used with the current event. */
                                    const event_handlers = aggregates[aggregate]["event_handlers"];

                                    var apply;
                                    if ( event_handlers[event.event_name] !== undefined ) {
                                        apply = event_handlers[event.event_name];
                                    } else {
                                        const event_handler_keys = Object.keys(event_handlers);
                                        throw `No such event handler. Choose from the list: ${event_handler_keys}`
                                    };
                                    /* ===================================== */

                                    if (state_store[aggregate] === undefined) {
                                        state_store[aggregate] = {};
                                    }

                                    if (state_store[aggregate][stream_id] === undefined) {
                                        state_store[aggregate][stream_id] = { timestamp: 0};
                                    }

                                    const instance_previous_state  = state_store[aggregate][stream_id];
                                    const previous_state_timestamp = instance_previous_state.timestamp;

                                    /* TEST: `cling()` not invoked, add events, and start */
                                    if (event.timestamp <= previous_state_timestamp) {
                                        console.log(`${event_id} do nothing` );
                                    } else {
                                        console.log(`${event_id} replay event and return` );

                                        var projectile = apply(event_snapshot, instance_previous_state);
                                        projectile["timestamp"] = event.timestamp;

                                        Object.assign(instance_previous_state, projectile);
                                        FIREBASE_APP.database().ref(`/state/${aggregate}`).child(stream_id).update(instance_previous_state);
                                    }
                                }
                            );
                        }
                    );
                }
            )
        }
    )
}

/* Purpose: (1) Attach a listener to 'event_store', that will
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
function cling() {


//             const event_store = db.ref('event_store');

//             event_store.on(
//                 'child_added',
//                 function(stream) {
//                     event_store.child(stream.key).on(
//                         'child_added',
//                         /* In other Event Sourcing implementations, the `apply` function
//                         has 2 arguments:

//                             + the previous state and
//                             + an event (to update the previous state).

//                         Due to the usage of Firebase's Realtime Databse, this function
//                         is only the callback of the listeners attached to new events,
//                         that only takes one argument of DataSnapshot type.

//                         Therefore, we fetch the previous state from
//                         `/state/(aggregate)/(stream_id).

//                         --------------------------------------------------------------

//                         ANOTHER APPROACH would be to include the previous state of the
//                         specific aggregate attribute (eg. people's email) in the COMMANDS
//                         so that it would be readily avaiable on update, but this seems
//                         cleaner.

//                         Also, a downside of fetching the state in `apply`, is that this
//                         needs an extra database query.
//                         */
//                         function applicator(event_snapshot) {

//                             // ALWAYS make sure applying events are idempotent.
//                             // ================================================

//                             const event = event_snapshot.val();
//                             const aggregate = event.aggregate;
//                             const stream_id = event_snapshot.ref.getParent().getKey();
//                             const event_id  = event_snapshot.ref.getKey();

//                             const event_handlers = aggregates[aggregate]["event_handlers"];

//                             var apply;
//                             if ( event_handlers[event.event_name] !== undefined ) {
//                                 apply = event_handlers[event.event_name];
//                             } else {
//                                 const event_handler_keys = Object.keys(event_handlers);
//                                 throw `No such event handler. Choose from the list: ${event_handler_keys}`
//                             };

//                             /* Replay events in the right order in case of a server restart. Because of
//                                issue #1, the events get passed in backwards order into the fetch state
//                                phase below, when `on()` listeners are first activated.  */

//                             // PULL TO TOP FOR CLOUD FUNCTIONS (i.e., between the last `on()` and on top of `applicator()`
//                             console.log(`${event_id} - ${event.timestamp} < ${initial_state_timestamp} new event`);
//                             db.ref(`/state/${aggregate}`).child(stream_id).once("value").then(build_next_state);
//                         }
//                     );
//                 }
//             );
        }
    // );
// }

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
           (REQUIRED) user_id:    "",
           (REQUIRED) email:      "",
                      address:    "",
                      phone_number: "",
           (REQUIRED) account_type: [ "admin" | "reader" | "listener" ],
       }
    */
    add_user: function(person) {

        if (person.username === undefined) {
            person["username"] = `${person.first_name} ${person.last_name}`;
        }

        FIREBASE_APP.auth().createUser(
            {
                "disabled":     false,
                "displayName":  person.username,
                "email":        person.email,
                "phoneNumber":  person.phone_number,
                /* A person can be member to multiple groups, but using the same
                   "stream_id"; they cannot be added multiple times anyway and
                   easier to check for presence.*/
                // TODO: Is the above a good idea?...
                /* ANSWER: No, but with Firebase, there can be one user with the
                           same email, therefore group membership is an artificial
                           construct, and authorization will be implemented using
                           security rules.
                */
                "uid":          person.user_id
            }
        ).then(
            function(user_record) {

                const person = aggregates.people.new_instance();

                const commands =
                    [
                        {
                            command: "add_person",
                            payload: {
                                "first_name": person.first_name,
                                "last_name":  person.last_name
                            }
                        },
                        {
                            command: "add_email",
                            payload: { "email": person.email }
                        }
                    ]
            }
        );
    }
}

//     firebase_admin.auth().createUser({ email: person.email }).then(function(userRecord) {

//         const db = firebase_admin.database();
//         const people_ref = db.ref("event_store");
//         const timestamp = firebase_admin.database.ServerValue.TIMESTAMP;

//         /* If user creation is successful, save "person_added" event, ... */

//         store_event(
//             people_ref,
//             "person_added",
//             {
//                 "user_id": userRecord.uid,
//                 "name": {
//                     "first": person.name.first,
//                     "last":  person.name.last
//                 }
//             },
//             timestamp,
//             0

//         ).then(function(_ref) {

//             /* ... save "person_email_added" after above event finishes, and ... */

//             store_event(
//                 people_ref,
//                 "person_email_added",
//                 {
//                     "user_id": userRecord.uid,
//                     "value":   person.email
//                 },
//                 timestamp,
//                 0
//             )
//         }).then(function(_ref) {

//             /* ... finally store the "<account>_added" event. */

//             const account_event = account_type + "_added";

//             store_event(
//                 db.ref("event_store"),
//                 account_event,
//                 {
//                     "user_id":  userRecord.uid,
//                     "username": person.email
//                 },
//                 timestamp,
//                 0
//             );
//         }).catch(function(error) { console.log(error) });

//         firebase_client.auth().sendPasswordResetEmail(person.email);
//     });
// };

module.exports = {
    init_firebase_admin,
    init_firebase_client,
    create_new_stream,
    append_event_to_stream,
    EVENT_VERSION,
    FIREBASE_APP,
    aggregates,
    execute,
    cling,
    state_store,
    apply_factories,
    rebuild_state
};

// const f = require('./admin-functions.js');
// const p1 = f.aggregates.people.new_instance(); f.execute(p1, 'add_person', { first_name: "Kilgore", last_name: "Troutman"})
// f.cling()
// const p2 = f.aggregates.people.new_instance(); f.execute(p2, 'add_person', { first_name: "Jorge", last_name: "Avenfasz"})

// TEST NAME CHANGE
// stream_id = "-LJFgGnFyyn9lhHwNEdd";
// f.execute({stream_id: stream_id, type: "people"}, 'change_name', { first_name: "Jorge", last_name: "Faszven"})

// TEST ADDING MULTIPLE EMAILS
// f.execute({stream_id: stream_id, type: "people"}, 'add_email', { email: "jorge@el.com"})
// f.execute({stream_id: stream_id, type: "people"}, 'add_email', { email: "ven@fasz.com"})
// f.execute({stream_id: stream_id, type: "people"}, 'add_email', { email: "jorge@nemel.com"})

// TEST UPDATING EMAILS
// var event_id = "-LJFiZugy9UuXv_0I9zS"; // in this case `event_id` === `email_id`
// f.execute({stream_id: stream_id, type: "people"}, 'update_email', { email: "val@ami.com", event_id: event_id})

