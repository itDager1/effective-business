import https from 'https';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
https.globalAgent.options.rejectUnauthorized = false;
