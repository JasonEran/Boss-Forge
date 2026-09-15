/** Reads only elements bound to an acknowledged message in the selected chat.
 * Unsupported native cards remain unavailable until their visible structure can
 * be mapped; free-form chat text is never treated as a shared contact card. */
export function chatAssetsScript(): string {
  return `(() => {
    const ids=new Set([m.serverMid,m.mid].filter(Boolean).map(String));
    const containers=Array.from(hosts[0].querySelectorAll?.('[data-mid],[data-message-id],.message-item,.chat-message,.message')||[]);
    const matches=containers.filter(e=>{
      const model=e.__vue__?.message$||e.__vue__?.message||e.__vue__?.item;
      return [e.getAttribute?.('data-mid'),e.getAttribute?.('data-message-id'),model?.serverMid,model?.mid].some(v=>v&&ids.has(String(v)));
    });
    if(matches.length!==1)return {assets:[],contacts:[]};
    const root=matches[0],assets=[],contacts=[];
    const safe=v=>{try{const u=new URL(v,location.href);return u.protocol==='https:'&&!u.username&&!u.password&&(!u.port||u.port==='443')&&['zhipin.com','zhipincdn.com','bosszhipin.com'].some(h=>u.hostname===h||u.hostname.endsWith('.'+h))?u.href:null;}catch{return null;}};
    if(kind==='image')for(const img of root.querySelectorAll('img')){
      if(/avatar|head|emoji|emotion/i.test(String(img.className)))continue;
      const url=safe(img.getAttribute('data-original')||img.currentSrc||img.src);if(url)assets.push({kind:'image',url,name:'聊天图片'});
    }
    if(kind==='file'||kind==='card')for(const a of root.querySelectorAll('a[href]')){
      const url=safe(a.href);if(!url)continue;
      const name=(a.getAttribute('download')||a.textContent||'').trim().slice(0,200);
      if(!/\\.(pdf|docx?|xlsx?|txt|png|jpe?g|webp)(?:$|[?#])/i.test(url)&&!a.hasAttribute('download')&&!/file|resume|attachment/i.test(String(a.className)))continue;
      assets.push({kind:'file',url,name:name||'候选人附件'});
    }
    if(kind==='card'&&!self){
      const content=(root.innerText||root.textContent||'').trim();
      const wechat=content.match(/(?:^|[\\s：:])微信号[：:\\s]+([a-zA-Z][a-zA-Z0-9_-]{5,31})(?=$|[\\s，。;；])/u);
      const phone=content.match(/(?:^|[\\s：:])(?:手机号|手机号码)[：:\\s]+((?:\\+86[ -]?)?1[3-9]\\d{9})(?=$|[\\s，。;；])/u);
      if(wechat)contacts.push({kind:'wechat',value:wechat[1],providerMessageId});
      if(phone)contacts.push({kind:'phone',value:phone[1],providerMessageId});
    }
    return {assets:assets.filter((a,i,l)=>l.findIndex(x=>x.url===a.url)===i).slice(0,10),contacts};
  })()`;
}
