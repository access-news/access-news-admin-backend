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

const firebase_admin = init_firebase_admin();

function init_firebase_client() {

    const firebase_client = require('firebase');
    const config = require('./firebase_client_config.json');
    firebase_client.initializeApp(config);

    return firebase_client;
};

const firebase_client = init_firebase_client();

var FIREBASE_APP = firebase_admin;

/* ADMIN COMMANDS */

/* 0. Helpers */

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

/* Function name is misleading because it also saves events to
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

// function start_new_stream_with_event(event) {

//     const id_of_new_stream = create_new_stream();
//     append_event_to_stream(id_of_new_stream, event);

//     return id_of_new_stream;
// }

/* NOTE: Event fields need to be one-dimensonal (-> easier checks) */
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

    const event_store = FIREBASE_APP.database().ref('event_store');

    event_store.on(
        'child_added',
        function(stream) {
            event_store.child(stream.key).on(
                'child_added',
                applicator
            );
        }
    );
}

// 1. Aggregate and helpers

const apply_factory = {

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

        return new Function("event_snapshot", "previous_state_snapshot",
                `
                const event    = event_snapshot.val();
                const event_id = event_snapshot.ref.getKey();

                // The previous state will be used to build the new state.
                var state    = previous_state_snapshot.val();

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

        return new Function("event_snapshot", "previous_state_snapshot",
                `
                const event = event_snapshot.val();
                var   state = previous_state_snapshot.val();

                state["${o.state_attribute}"][event.fields.event_id] = event["fields"]["${o.event_field}"];

                return state;
                `)
    },

    delete_for_multi: function(o) { /* See `o`'s description at `add_for_multi` */

        /* o = { state_attribute: "emails" } */

        return new Function("event_snapshot", "previous_state_snapshot",
                `
                const event = event_snapshot.val();
                var   state = previous_state_snapshot.val();

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
                event_name: 'person_name_changed',
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
        },

        /* Used by `applicator`. These are the actual `apply` functions
           to mutate the state of a specifig aggregate instance applying the
           provided event. In `applicator` they are actually called `apply`.
        */
        event_handlers: {

            /* Don't need the previous state, because this command creates a
               brand new instance, so there is nothing to mess up. */
            "person_added": function(event_snapshot) {
                return { "name": event_snapshot.val().fields };
            },

            "person_name_changed": function(event_snapshot, previous_state_snapshot) {
                const event    = event_snapshot.val();
                // The previous state will be used to build the new state.
                var state    = previous_state_snapshot.val();
                state["name"] = event.fields;

                return state;
            },

            "email_added":
                apply_factory.add_for_multi({
                    state_attribute: "emails",
                    event_field:     "email"
                }),

            "email_updated":
                apply_factory.update_for_multi({
                    state_attribute: "emails",
                    event_field:     "email"
                }),

            "email_deleted":
                apply_factory.delete_for_multi({
                    state_attribute: "emails"
                }),

            // if no handler specified for event, use this.
            "generic": function(event_snapshot, previous_state_snapshot) {
                var state = previous_state_snapshot.val();
                return Object.assign(state, event_snapshot.val().fields);
            },
        }
    },
};

const commands = {

//  aggregate
    people: {

        /* add_person

            checking for the duplicate entries when trying to create a new one
            will be responsibility of the front end client (when it is ready...).
            there can be users with the same name, etc. therefore in the
            beginning it will be easer to use humans to decide if there is a
            genuine duplicate or not.

            whenever this command is called, the deliberation process should
            already be over and it means that someone chose to allow the creation
            of a new user.
        */
    }
}

//               ------ state -----
function execute(aggregate_instance, command, payload, callback) {
//               {} or null if new
//               or plainly ignored

    /* required parameters:
       + aggregate_instance
       + command
       + payload
    */

    if (callback) {
        callback();
    }

    const is_stream_new = (aggregate_instance.stream_id === undefined);
    const stream_id = (is_stream_new) ? create_new_stream() : aggregate_instance.stream_id;

    const aggregate_type = aggregate_instance.type;
    const c = aggregates[aggregate_type]["commands"][command];

    if (c === undefined) {
        throw `command "${command}" does not exist`;
    }

    const fields =
        cast_event_payload(
            {
                "required_fields": c.required_fields,
                "payload":         payload
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

/* In other Event Sourcing implementations, the `apply` function
   has 2 arguments:

     + the previous state and
     + an event (to update the previous state).

   Due to the usage of Firebase's Realtime Databse, this function
   is only the callback of the listeners attached to new events,
   that only takes one argument of DataSnapshot type.

   Therefore, we fetch the previous state from
   `/state/(aggregate)/(stream_id).

   --------------------------------------------------------------

   ANOTHER APPROACH would be to include the previous state of the
   specific aggregate attribute (eg. people's email) in the COMMANDS
   so that it would be readily avaiable on update, but this seems
   cleaner.

   Also, a downside of fetching the state in `apply`, is that this
   needs an extra database query.
*/
function applicator(event_snapshot) {

    // ALWAYS make sure applying events are idempotent.
    // ================================================

    const event = event_snapshot.val();
    const aggregate = event.aggregate;
    const stream_id = event_snapshot.ref.getParent().getKey();
    const event_id  = event_snapshot.ref.getKey();

    // Fetch previous state.
    const db = FIREBASE_APP.database();
    const aggregate_ref = db.ref(`/state/${aggregate}`);

    const event_handlers = aggregates[aggregate]["event_handlers"];
    var apply;
    if ( event_handlers[event.event_name] !== undefined ) {
        apply = event_handlers[event.event_name];
    } else {
        apply = event_handlers["generic"];
    };

    aggregate_ref.child(stream_id).once("value").then(
        function(previous_state_snapshot) {

            var projectile = apply(event_snapshot, previous_state_snapshot);

            /* TODO: At one point use this to only evaluate events from the
                        point where they haven't been applied yet. */
            /* POTENTIAL BUG:
               May not be an issue once `cling()` deployed as a cloud function
               but just in case:
               When Node is restarted, "latest_event_id" will become the stream's
               **first** event_id, because for some reason the events are read
               from newest to oldest, when reattached.

               Because of `cling()`'s idempotency, this doesn't seem to be an
               issue, but not ideal.
            */
            projectile["latest_event_id"] = event_id;

            aggregate_ref.child(stream_id).update(projectile);
        }
    );
}

// function add_user(fire_app, fields, account_type) {

//     /* `person` object:
//        ================
//         {
//             name: {
//                 first: "Bala",
//                 last:  "Bab"
//             },
//             email: "ema@il.com"
//         }

//         `account_type`: [ "admin" | "reader" | "listener" ]
//     */

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
    firebase_admin,
    firebase_client,
    create_new_stream,
    append_event_to_stream,
    EVENT_VERSION,
    FIREBASE_APP,
    aggregates,
    execute,
    commands,
    cling,
    apply_factory
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

