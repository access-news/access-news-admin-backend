const functions = require('firebase-functions');

const admin = require('firebase-admin');
admin.initializeApp();

exports.lofa = functions.database.ref('/event_store').onCreate((snap, context) => {
  console.log(`meg ilyet: ${snap}`);
  return null;
})

exports.apply = functions.database.ref("/event_store").onCreate(
  function(event_snapshot, context) {

    function dispatch_event_handler() {

      const event = event_snapshot.val();
      const event_id = event_snapshot.ref.getKey();

      const stream_id = event.stream_id;
      console.log(`stream_id: ${stream_id}`);

      const state_ref = admin.database().ref("/state_store").child(stream_id);

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

      function update_stream_state(update) {
        update["_meta/seq"] = event.seq;
        update["_meta/aggregate"] = event.aggregate;

        update[`_meta/event_ids/${event_id}`] = event.timestamp;

        return state_ref.update(update);
      }

      /* For list attributes of an aggregate, such as emails,
          phone numbers, etc.

          After dropping the "reason" and "from" fields (where included),
          there should only be one field remaining. (See commands above.)
          If this is not the case, I messed up. Again.
      */
      function for_multi(p) {

        /* The "p" (as in "parameters") object in the factories below it
          therefore mostly to make pluralization rules explicit:

                "attribute": The plural name of the attribute in the state.

                "event_field": The singular event field name for the datum.
        */

        return function(event_snapshot) {

          delete event.fields.reason;

          var update = {};
          if ( event.fields.from !== undefined) {

            update[`${p.attr}/${sanitize_key(event.fields.from)}`] = null;
            delete event.fields.from;
          }

          const k = Object.keys(event.fields)[0];
          const v   = event["fields"][k];

          update[`${p.attr}/${sanitize_key(v)}`] = !p.drop ? event_id : null;

          return update_stream_state(update);
        }
      }

      function for_person_name() {

        return function(event_snapshot) {

          delete event.fields.reason

          var update = {};
          update["name"] = event.fields;

          return update_stream_state(update);
        }
      }

      function for_general() {

        return function(event_snapshot) {
          return update_stream_state(event.fields);
        }
      }

      switch (event.event_name) {

        case "person_added":
        case "person_name_changed":
          return for_person_name();

        case "email_added":
        case "email_updated":
          return for_multi({
            attr: "emails",
          });
        case "email_deleted":
          return for_multi({
            attr: "emails",
            drop: true
          });

        case "phone_number_added":
        case "phone_number_updated":
          return for_multi({
            attr: "phone_numbers",
          });
        case "phone_number_deleted":
          return for_multi({
            attr: "phone_numbers",
            drop: true
          });

        case "added_to_group":
          return for_multi({
            attr: "groups",
          });
        case "removed_from_group":
          return for_multi({
            attr: "groups",
            drop: true
          });

        case "session_started":
        case "session_time_updated":
        case "session_ended":
          return for_general();

        case "recording_added":
          return for_general();

        default:
          return function() {
            const errText = `No such event: ${event.event_name}`;
            return Promise.reject(Error(errText));
          }

      }
    }

    return dispatch_event_handler()(event_snapshot).catch(
      function(err) {
        console.error(err);
        return Promise.reject(err);
    });
  }
)
