const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

function verifyTelegramInitData(initData, token) {
  if (!initData || !token) throw new Error("Telegram Web App orqali qayta kiring.");
  const p = new URLSearchParams(initData);
  const hash = p.get("hash");
  if (!hash) throw new Error("Telegram imzosi topilmadi.");
  p.delete("hash");
  const check = [...p.entries()].sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => k + "=" + v).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(token).digest();
  const expected = crypto.createHmac("sha256", secret).update(check).digest("hex");
  const a = Buffer.from(hash, "hex"), b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a,b)) throw new Error("Telegram imzosi noto'g'ri.");
  const now = Math.floor(Date.now()/1000), authDate = Number(p.get("auth_date") || 0);
  if (!authDate || now-authDate > 86400 || authDate > now+60) throw new Error("Telegram sessiyasi eskirgan. Web Appni qayta oching.");
  const user = JSON.parse(p.get("user") || "{}");
  if (!Number.isSafeInteger(Number(user.id))) throw new Error("Telegram foydalanuvchisi aniqlanmadi.");
  return user;
}
function fileName(value) {
  const s = String(value || "slayd-ai-taqdimot")
    .replace(/\.pdf$/i, "")
    .replace(new RegExp('[\\\\/:*?"<>|\\u0000-\\u001f]', "g"), " ")
    .replace(/\s+/g, " ").trim().slice(0, 90);
  return (s || "slayd-ai-taqdimot") + ".pdf";
}
function cleanSlide(s,i) {
  const title=String(s.title||"").trim().slice(0,160);
  const bullets=Array.isArray(s.bullets)?s.bullets.slice(0,5).map(x=>String(x||"").trim().slice(0,500)).filter(Boolean):[];
  if(!title||!bullets.length) throw new Error((i+1)+"-slayd sarlavhasi yoki matni bo'sh.");
  return {title,bullets,speaker_notes:String(s.speaker_notes||"").slice(0,2000)};
}
function startWebApp({bot,db,makeSlides,createPdf,generateSlideImages,InputFile,botToken}) {
  const app=express(); app.disable("x-powered-by"); app.use(express.json({limit:"24mb"}));
  app.use(express.static(path.join(__dirname,"../public"),{extensions:["html"]}));
  const rate=new Map();
  function auth(req,res,next){try{req.tgUser=verifyTelegramInitData(req.get("x-telegram-init-data"),botToken);next();}catch(e){res.status(401).json({error:e.message});}}
  function limit(req,res,next){const id=String(req.tgUser.id),now=Date.now(),old=(rate.get(id)||[]).filter(x=>now-x<60000);if(old.length>=4)return res.status(429).json({error:"Bir daqiqada 4 ta so'rov limiti. Biroz kuting."});old.push(now);rate.set(id,old);next();}
  app.get("/health",(_q,res)=>res.json({ok:true,service:"slayd-ai"}));
  app.post("/api/generate",auth,limit,async(req,res)=>{
    if(!db)return res.status(503).json({error:"Ma'lumotlar bazasi ulanmagan."});
    const topic=String(req.body?.topic||"").trim().slice(0,2000),uid=Number(req.tgUser.id);if(topic.length<4)return res.status(400).json({error:"Mavzuni kamida 4 ta belgida yozing."});
    let pid;
    try{
      await db.query("insert into public.slayd_users (telegram_id,username,first_name,last_name,last_seen_at) values ($1,$2,$3,$4,now()) on conflict (telegram_id) do update set username=excluded.username,first_name=excluded.first_name,last_name=excluded.last_name,last_seen_at=now()",
        [uid,req.tgUser.username||null,req.tgUser.first_name||null,req.tgUser.last_name||null]);
      const r=await db.query("insert into public.slayd_projects (telegram_user_id,topic,file_name,input_type,image_mode,status,slide_count) values ($1,$2,$3,'web_editor','user','generating',8) returning id",
        [uid,topic,fileName(req.body.fileName)]);pid=r.rows[0].id;
      const data=await makeSlides(topic);
      const client=await db.connect();
      try{
        await client.query("begin");
        for(let i=0;i<data.slides.length;i++){const s=data.slides[i];await client.query("insert into public.slayd_slides (project_id,slide_number,title,body,speaker_notes) values ($1,$2,$3,$4,$5)",[pid,i+1,s.title,(s.bullets||[]).join("\n"),s.speaker_notes||""]);}
        await client.query("update public.slayd_projects set status='draft',updated_at=now() where id=$1 and telegram_user_id=$2",[pid,uid]);await client.query("commit");
      }catch(e){await client.query("rollback");throw e;}finally{client.release();}
      res.json({projectId:pid,title:data.title||topic,subtitle:data.subtitle||"SLAYD AI taqdimoti",slides:data.slides});
    }catch(e){if(pid)try{await db.query("update public.slayd_projects set status='failed',error_message=$1,updated_at=now() where id=$2 and telegram_user_id=$3",[String(e.message).slice(0,1000),pid,uid]);}catch(_){}console.error("Web generate:",e);res.status(500).json({error:"Taqdimot yaratilmadi. Birozdan keyin qayta urinib ko'ring."});}
  });
  app.post("/api/finish",auth,limit,async(req,res)=>{
    if(!db)return res.status(503).json({error:"Ma'lumotlar bazasi ulanmagan."});
    const uid=Number(req.tgUser.id),pid=String(req.body?.projectId||""),name=fileName(req.body?.fileName),title=String(req.body?.title||"SLAYD AI").slice(0,160),input=req.body?.slides;
    if(!/^[0-9a-f-]{36}$/i.test(pid)||!Array.isArray(input)||input.length<6||input.length>8)return res.status(400).json({error:"Taqdimot ma'lumotlari noto'g'ri."});
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),"slayd-web-")),pdf=path.join(dir,name);
    try{
      const claim=await db.query("update public.slayd_projects set status='generating',file_name=$1,updated_at=now() where id=$2 and telegram_user_id=$3 and status='draft' returning id",[name,pid,uid]);
      if(!claim.rowCount)return res.status(409).json({error:"Taqdimot topilmadi, allaqachon yuborilmoqda yoki yakunlangan."});
      const slides=[];
      for(let i=0;i<input.length;i++){
        const s=cleanSlide(input[i],i);
        if(input[i].imageData){const m=/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(input[i].imageData);if(!m)throw new Error((i+1)+"-slayd rasmi PNG yoki JPG bo'lishi kerak.");const bytes=Buffer.from(m[2],"base64");if(bytes.length>5*1024*1024)throw new Error("Rasm 5 MB dan katta.");const img=path.join(dir,"slide-"+(i+1)+(m[1]==="png"?".png":".jpg"));fs.writeFileSync(img,bytes,{flag:"wx"});s.imagePath=img;}
        slides.push(s);
      }
      if (generateSlideImages) await generateSlideImages({title,slides},dir);
      await createPdf({title,subtitle:"SLAYD AI orqali tayyorlandi",slides},pdf);
      await bot.api.sendDocument(uid,new InputFile(pdf,name),{caption:"✅ Taqdimotingiz tayyor va Telegram chatga yuborildi!"});
      const client=await db.connect();
      try{
        await client.query("begin");
        await client.query("delete from public.slayd_slides where project_id=$1",[pid]);
        for(let i=0;i<slides.length;i++){const s=slides[i];await client.query("insert into public.slayd_slides (project_id,slide_number,title,body,speaker_notes,image_path) values ($1,$2,$3,$4,$5,$6)",[pid,i+1,s.title,s.bullets.join("\n"),s.speaker_notes,null]);}
        await client.query("update public.slayd_projects set status='completed',pdf_path=$1,updated_at=now() where id=$2 and telegram_user_id=$3",[name,pid,uid]);await client.query("commit");
      }catch(e){await client.query("rollback");throw e;}finally{client.release();}
      res.json({ok:true,message:"PDF Telegram chatga yuborildi."});
    }catch(e){console.error("Web finish:",e);try{await db.query("update public.slayd_projects set status='failed',error_message=$1,updated_at=now() where id=$2 and telegram_user_id=$3",[String(e.message).slice(0,1000),pid,uid]);}catch(_){}res.status(500).json({error:e.message||"PDF yaratish yoki yuborishda xatolik."});}
    finally{fs.rmSync(dir,{recursive:true,force:true});}
  });
  const port=Number(process.env.PORT||3000),server=app.listen(port,"0.0.0.0",()=>console.log("SLAYD AI Web App server listening on "+port));server.on("error",e=>console.error("Web server:",e));return server;
}
module.exports={startWebApp,verifyTelegramInitData};
