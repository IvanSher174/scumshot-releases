'use strict';
// Consumer fixture: verifyStatus from github-status.cjs in the published v0.4.61 app.asar.
// Installer SHA-256: 8305174c9c32db8349042d189b6711c2f9077d113da2bb3535c74e4f44f1d2ee.
const crypto=require('node:crypto');
const MAX_AGE=20*60*1000;
function verifyStatus(envelope,key,server,now=Date.now()){
 if(typeof envelope?.payload!=='string'||envelope.payload.length>8192||typeof envelope.signature!=='string'||envelope.signature.length>128)throw Error('Неверный формат статуса сервера.');
 const bytes=Buffer.from(envelope.payload,'base64');
 if(!crypto.verify(null,bytes,key,Buffer.from(envelope.signature,'base64')))throw Error('Подпись статуса сервера не совпала.');
 const data=JSON.parse(bytes.toString('utf8'));
 if(data.kind!=='scumshot-public-status'||data.version!==1||data.server!==server||typeof data.online!=='boolean'||
    !(data.players===null||Number.isSafeInteger(data.players)&&data.players>=0&&data.players<=10000)||
    !Number.isSafeInteger(data.checkedAt)||now-data.checkedAt>MAX_AGE||data.checkedAt-now>60000)throw Error('Статус сервера устарел или содержит неверные данные.');
 return {status:data.online?'online':'offline',players:data.players,source:'wardencore-github',checkedAt:data.checkedAt,
  message:'WardenCore через GitHub · данные на '+new Date(data.checkedAt).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'})};
}
module.exports={verifyStatus,MAX_AGE};
