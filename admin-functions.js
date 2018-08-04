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

var EVENT_VERSION = 0;

function create_new_stream() {
    return FIREBASE_APP.database().ref("event_store").push().key;
}

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

// ! Use events created with `create_event`
function append_event_to_stream(stream_id, event) {

    FIREBASE_APP.database().ref("event_store").child(stream_id).push(event);
};

function start_new_stream_with_event(event) {

    const id_of_new_stream = create_new_stream();
    append_event_to_stream(id_of_new_stream, event);

    return id_of_new_stream;
}

/* NOTE: Event fields need to be one-dimensonal (-> easier checks) */
function create_event(o) {

    /* o =
        {
           event_name:      'person_added',
           required_fields: [ "prop1", ..., "propN"],
           payload:         { field: "val", ... },
           version:         EVENT_VERSION
        }
    */

    const fields =
        cast_event_payload(
            {
                event_name:      o.event_name,
                required_fields: o.required_fields,
                payload:         o.payload
            });

    var event = {
        "event_name":  o.event_name,
        "fields":      fields,
        "timestamp":   FIREBASE_APP.database.ServerValue.TIMESTAMP,
        "version":     o.version
    }

    return event;
}

/* Generate meaningful errors */
function cast_event_payload(o) {

    /* {
           event_name:      'person_added',
           required_fields: [ "prop1", ..., "propN"],
           payload:         { field: "val", ... }
       }
    */

    var fields = {};

    const payload_properties = Object.keys(o.payload);

    if (payload_properties.length !== o.required_fields.length) {
        throw `Extraneous fields, expected: ${o.required_fields}, got: ${payload_properties}`
    }

    for (var i in payload_properties) {

        const payload_prop = payload_properties[i];

        if (o.required_fields.includes(payload_prop) === false) {
            throw `${o.event_name} expects the fields: ${o.required_fields}, no match for: ${payload_prop}`
        }

        fields[payload_prop] = o.payload[payload_prop];
    }

    return fields;
}

/* 1. Aggregates */

/* This would be the Elixir module equivalent, and aggregates should be
   singletons (i.e., simple objects).

   Aggregate instances, such as Person, would have their own constructor,
   and populated with the state coming from projections. These aggregate
   instances would be fed back to subsequent commands and parsed for
   compatibility with the business rules.

   For example,

      var kilgore = new Person(projection_entry);

      people.execute(kilgore, 'person_update_address', fields)
*/

const people = {

    new_person: new (function Person() {})(),

    //                STATE
    execute: function(person, command, payload) {

        switch (command) {

            /* ADD_PERSON

               Checking for the duplicate entries when trying to create a new one
               will be responsibility of the front end client (when it is ready...).
               There can be users with the same name, etc. therefore in the
               beginning it will be easer to use humans to decide if there is a
               genuine duplicate or not.

               Whenever this command is called, the deliberation process should
               already be over and it means that someone chose to allow the creation
               of a new user.
            */

            case 'add_person':
                /* In this case, there is no STATE, so `this.execute`'s `person`
                   parameter can be ignored. (Best to use an empty object.)

                   For example:
                   > f.aggregates.people.execute({},'add_person', { first_name: "a", last_name: "b"})
                */

                start_new_stream_with_event(
                    create_event(
                        {
                            event_name:      'person_added',
                            required_fields: ['first_name', 'last_name'],
                            payload:         payload,
                            version:         EVENT_VERSION
                        })
                    );

                break;

            case 'add_email':

                /* Just like with `add_person', not checking for duplicates here */

                append_event_to_stream(
                    person.stream_id,
                    create_event(
                        {
                            event_name:      'email_added',
                            required_fields: ['email'],
                            payload:         payload,
                            version:         EVENT_VERSION
                        })
                );

                break;

            case 'update_email':

                append_event_to_stream(
                    person.stream_id,
                    create_event(
                        {
                            event_name:      'email_updated',
                            required_fields: ['email', 'event_id'],
                            payload:         payload,
                            version:         EVENT_VERSION
                        })
                );

                break;

            case 'delete_email':

                append_event_to_stream(
                    person.stream_id,
                    create_event(
                        {
                            event_name:      'email_updated',
                            required_fields: ['event_id'],
                            payload:         payload,
                            version:         EVENT_VERSION
                        })
                );

                break;

            /* ADD_USER

               Comparing email addresses in the same group to filter out duplicates.
            */
            case 'add_user':
                FIREBASE_APP.auth().createUser(
                    { email: payload.email }
                ).then(
                    function(userRecord) {

                    }
                )
        }
    },

    apply: function(eventSnapshot) {

        // ALWAYS make sure applying events are idempotent.
        // ================================================

        const event     = eventSnapshot.val();
        const stream_id = eventSnapshot.ref.getParent().getKey();

        const ref = f.FIREBASE_APP.database().ref('people').child(stream_id);

        var projectile = 
            {
                /* At one point use this to only evaluate events from the
                   point where they haven't been applied yet. */
                "latest_event_id": eventSnapshot.ref.getKey()
            };

        switch (event.event_name) {

            case 'person_added':
                projectile["name"] = event.fields;
                break;

            case 'email_added':
                Object.assign(projectile, event.fields)
                break;
        }

        ref.update(projectile);
    }
}

/* Whenever the admin server (i.e., the Node REPL for now) restarts
   for whatever reason, this file will be required, and this function
   will run.

   Purpose: (1) Attach a listener to 'event_store', that will
            (2) attach a listener to each stream_id to listen to
                new events.

            When a new stream is started, (1) will attach a listener
            to it, listening to new events within the stream. When a
            new event comes in, it will be `apply`ed (i.e., projections
            updated).
*/
function cling() {

    const event_store = FIREBASE_APP.database().ref('event_store');

    event_store.on(
        'child_added',
        function(stream) {
            event_store.child(stream.key).on(
                'child_added',
                aggregates.people.apply
            );
        }
    );
}

const aggregates = {
    people: people
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
    start_new_stream_with_event,
    EVENT_VERSION,
    FIREBASE_APP,
    aggregates,
    cling
};
