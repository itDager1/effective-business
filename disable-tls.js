import 'dotenv/config';
import https from 'https';

if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
  https.globalAgent.options.rejectUnauthorized = false;
}
