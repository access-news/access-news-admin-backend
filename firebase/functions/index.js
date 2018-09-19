const functions = require('firebase-functions');

const admin = require('firebase-admin');
admin.initializeApp();

exports.project = functions.database.ref('/state_store/{stream_id}').onWrite(
  function(change, context) {

    const stream = change.after.val();
    const stream_id = context.params.stream_id;
    const aggregate = stream["_meta"]["aggregate"];
    const user_id = (aggregate === 'person') ? stream_id : stream.user_id;

    const t = (function timestamps(stream) {

      const event_ids = Object.keys(stream._meta.event_ids);
      const oldest_key = event_ids[0];
      const newest_key = event_ids[event_ids.length-1];

      const [created_at, updated_at] = [
        stream._meta.event_ids[ oldest_key ],
        stream._meta.event_ids[ newest_key ]
      ].map(
        function(timestamp) {
          return new Date(timestamp).toISOString().split(/[T.Z]/).slice(0,3);
        }
      );

      return {
        'created_at': {
          'date': created_at[0],
          'time': created_at[1],
          'ms':   created_at[2]
        },
        'updated_at': {
          'date': updated_at[0],
          'time': updated_at[1],
          'ms':   updated_at[2]
        }
      };
    })(stream);

    (function put_timestamps_into_stream(stream) {
      stream["created_at"] = `${t.created_at.date}-${t.created_at.time}:${t.created_at.ms}`;
      stream["updated_at"] = `${t.updated_at.date}-${t.updated_at.time}:${t.created_at.ms}`;
    })(stream);

    var update = {};
    delete stream._meta;

    switch (aggregate) {
      case 'person':
        update[`people/${user_id}`] = stream;
        break;

      case 'session':
        update[`sessions/by_stream/${stream_id}`] = stream;

        stream["stream_id"] = stream_id;
        update[`sessions/by_date/${t.created_at.date}/${t.created_at.time}:${t.created_at.ms}`] = stream;

        update[`people/${user_id}/sessions/${t.created_at.date}/${t.created_at.time}:${t.created_at.ms}`] = stream;
        break;

      case 'recording':
        update[`recordings/by_stream/${stream_id}`] = stream;

        stream["stream_id"] = stream_id;
        update[`recordings/by_date/${t.created_at.date}/${t.created_at.time}:${t.created_at.ms}`] = stream;
        update[`recordings/by_datetime/${t.created_at.date}/${t.created_at.time}:${t.created_at.ms}`] = stream;

        update[`people/${user_id}/recordings/${t.created_at.date}/${t.created_at.time}:${t.created_at.ms}`] = stream;
        break;

      default:
        console.error(`No case for ${aggregate} aggregate`);
        return null;
    }

    return admin.database().ref('/projections').update(update);
  }
);

exports.apply = functions.database.ref("/event_store/{event_id}").onCreate(
  function(event_snapshot, context) {

    function dispatch_event_handler() {

      const event = event_snapshot.val();
      const event_id = context.params.event_id;
      console.log(event_id);

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
        // update["_meta/seq"] = event.seq;
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
