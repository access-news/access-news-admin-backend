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

function create_stream() {
    return FIREBASE_APP.database().ref("event_store").push().key;
}

function append_event_to_stream(stream_id, event_name, fields, version) {

    /* General structure of events:

                                      ----- event object ------
       event_store/stream_id/event_id/{event_name/...fields...},timestamp,version,seq

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

    var event = {
        "event_name": event_name,
        "fields": fields,
        "timestamp": FIREBASE_APP.database.ServerValue.TIMESTAMP,
        "version":   version
    };

    FIREBASE_APP.database().ref("event_store").child(stream_id).push(event);
};

function start_new_stream_with_event(event_name, fields, version) {

    const id_of_new_stream = create_stream();
    append_event_to_stream(id_of_new_stream, event_name, fields, version);

    return id_of_new_stream;
}

var EVENT_VERSION = 0;

module.exports = {
    firebase_admin,
    firebase_client,
    create_stream,
    append_event_to_stream,
    start_new_stream_with_event,
    EVENT_VERSION,
    FIREBASE_APP
};
