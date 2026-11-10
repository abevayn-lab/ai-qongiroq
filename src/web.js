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
  return {title,bullets,speaker_notes:String(s.speaker_notes||"").slice(0,2000),imagePosition:s.imagePosition==="left"?"left":"right"};
}
function startWebApp({bot,db,makeSlides,createPdf,generateSlideImages,InputFile,botToken,requiredChannel,freeTesterIds,adminTelegramId,clickServiceId,clickMerchantId,clickMerchantUserId,clickSecretKey,slidePriceUzs,webAppUrl}) {
  const app=express(); app.disable("x-powered-by"); app.use(express.json({limit:"24mb"})); app.use(express.urlencoded({extended:false,limit:"1mb"}));
  app.use(express.static(path.join(__dirname,"../public"),{extensions:["html"]}));
  const rate=new Map();
  const freeIds=new Set(String(freeTesterIds||"").split(",").map(x=>x.trim()).filter(Boolean));
  function isFreeUser(id){return Number(id)===Number(adminTelegramId)||freeIds.has(String(id));}
  async function channelMember(id){
    if(!requiredChannel)return true;
    try{
      const m=await bot.api.getChatMember(requiredChannel,id);
      return ["creator","administrator","member"].includes(m.status)||(m.status==="restricted"&&m.is_member===true);
    }catch(e){console.error("Web channel check:",e.message);return false;}
  }
  function auth(req,res,next){try{req.tgUser=verifyTelegramInitData(req.get("x-telegram-init-data"),botToken);next();}catch(e){res.status(401).json({error:e.message});}}
  function limit(req,res,next){
    const id=String(req.tgUser.id),now=Date.now(),old=(rate.get(id)||[]).filter(x=>now-x<60000);
    if(old.length>=4)return res.status(429).json({error:"Bir daqiqada 4 ta so'rov limiti. Biroz kuting."});
    old.push(now);rate.set(id,old);
    if(rate.size>5000){for(const [key,times] of rate.entries())if(!times.some(t=>now-t<60000))rate.delete(key);}
    next();
  }
  const asyncRoute=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
  app.get("/health",asyncRoute(async(_q,res)=>{
    let database="not_configured";
    if(db){try{await db.query("select 1");database="connected";}catch(_){database="unavailable";}}
    res.json({ok:true,service:"slayd-ai",database});
  }));
  app.get("/api/status",auth,asyncRoute(async(req,res)=>{
    const member=await channelMember(Number(req.tgUser.id));
    const clickReady=Boolean(clickServiceId&&clickMerchantId&&clickSecretKey&&Number.isSafeInteger(Number(slidePriceUzs))&&Number(slidePriceUzs)>0&&webAppUrl);
    res.json({ok:true,channelRequired:Boolean(requiredChannel),channelMember:member,free:isFreeUser(req.tgUser.id),clickReady,priceUzs:clickReady?Number(slidePriceUzs):null});
  }));
  app.post("/api/generate",auth,limit,asyncRoute(async(req,res)=>{
    if(!db)return res.status(503).json({error:"Ma'lumotlar bazasi ulanmagan."});
    const topic=String(req.body?.topic||"").trim().slice(0,2000),uid=Number(req.tgUser.id);
    if(topic.length<4)return res.status(400).json({error:"Mavzuni kamida 4 ta belgida yozing."});
    if(!(await channelMember(uid)))return res.status(403).json({error:"Davom etish uchun majburiy kanalga obuna bo'ling. Botga qaytib kanalga obuna bo'ling va qayta tekshiring."});

    const dailyLimit=Number(uid)===Number(adminTelegramId)?100:(isFreeUser(uid)?25:3);
    const daily=await db.query("select count(*)::int as n from public.slayd_projects where telegram_user_id=$1 and created_at>now()-interval '24 hours'",[uid]);
    if(Number(daily.rows[0].n)>=dailyLimit)return res.status(429).json({error:"Kunlik taqdimot limiti tugadi. Ertaga qayta urinib ko'ring."});
    const active=await db.query("select count(*)::int as n from public.slayd_projects where telegram_user_id=$1 and status in ('draft','generating','awaiting_payment','paid') and created_at>now()-interval '2 hours'",[uid]);
    if(Number(active.rows[0].n)>=(isFreeUser(uid)?4:2))return res.status(409).json({error:"Sizda yakunlanmagan taqdimotlar bor. Avval ularni yakunlang."});
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
    }catch(e){if(pid)try{await db.query("update public.slayd_projects set status='failed',error_message=$1,updated_at=now() where id=$2 and telegram_user_id=$3",[String(e.message).slice(0,1000),pid,uid]);}catch(_){}console.error("Web generate:",e);const busy=String(e.message||"").includes("navbat");res.status(busy?503:500).json({error:busy?e.message:"Taqdimot yaratilmadi. Birozdan keyin qayta urinib ko'ring."});}
  }));
  async function deliverPaidProject(projectId) {
    const claim=await db.query("update public.slayd_projects set status='generating',updated_at=now() where id=$1 and status='paid' returning *",[projectId]);
    if(!claim.rowCount)return;
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),"slayd-paid-"));
    try {
      const project=claim.rows[0];
      const slideResult=await db.query("select * from public.slayd_slides where project_id=$1 order by slide_number",[projectId]);
      if(!slideResult.rowCount)throw new Error("To'lov qilingan loyiha slaydlari topilmadi.");
      const slides=[];
      for(const row of slideResult.rows){
        const slide={id:row.id,title:row.title,bullets:String(row.body||"").split("\n").filter(Boolean),speaker_notes:row.speaker_notes||"",imagePosition:row.image_position||"right"};
        if(row.image_data){
          const ext=(row.image_mime||"image/png").includes("jpeg")?"jpg":"png";
          const imagePath=path.join(dir,"slide-"+row.slide_number+"."+ext);
          fs.writeFileSync(imagePath,Buffer.from(row.image_data));
          slide.imagePath=imagePath;
          slide.imageData=Buffer.from(row.image_data);
          slide.imageMime=row.image_mime||"image/png";
        }
        slides.push(slide);
      }
      if(generateSlideImages)await generateSlideImages({title:project.topic,slides},dir);
      for(const slide of slides){
        if(slide.imagePath&&!slide.imageData&&fs.existsSync(slide.imagePath)){
          slide.imageData=fs.readFileSync(slide.imagePath);
          slide.imageMime=path.extname(slide.imagePath).toLowerCase()===".jpg"?"image/jpeg":"image/png";
          await db.query("update public.slayd_slides set image_data=$1,image_mime=$2 where id=$3",[slide.imageData,slide.imageMime,slide.id]);
        }
      }
      const pdfPath=path.join(dir,fileName(project.file_name));
      await createPdf({title:project.topic||slides[0].title,subtitle:"SLAYD AI orqali tayyorlandi",slides},pdfPath);
      await bot.api.sendDocument(Number(project.telegram_user_id),new InputFile(pdfPath,fileName(project.file_name)),{caption:"✅ Click to'lovi tasdiqlandi. Taqdimotingiz tayyor va Telegram chatga yuborildi!"});
      await db.query("update public.slayd_projects set status='completed',pdf_path=$1,error_message=null,updated_at=now() where id=$2",[fileName(project.file_name),projectId]);
      try{await db.query("update public.slayd_slides set image_data=null,image_mime=null where project_id=$1",[projectId]);}catch(cleanupError){console.warn("Paid image cleanup:",cleanupError.message);}
    }catch(error){
      await db.query("update public.slayd_projects set status='paid',error_message=$1,updated_at=now() where id=$2",[String(error.message).slice(0,1000),projectId]);
      throw error;
    }finally{
      fs.rmSync(dir,{recursive:true,force:true});
    }
  }

  app.post("/api/finish",auth,limit,asyncRoute(async(req,res)=>{
    if(!db)return res.status(503).json({error:"Ma'lumotlar bazasi ulanmagan."});
    const uid=Number(req.tgUser.id),pid=String(req.body?.projectId||""),name=fileName(req.body?.fileName),title=String(req.body?.title||"SLAYD AI").slice(0,160),input=req.body?.slides;
    const free=isFreeUser(uid);
    const clickPrice=Number(slidePriceUzs);
    const clickReady=Boolean(clickServiceId&&clickMerchantId&&clickMerchantUserId&&clickSecretKey&&Number.isSafeInteger(clickPrice)&&clickPrice>0&&webAppUrl);
    if(!free&&!clickReady)return res.status(503).json({error:"Click hali sozlanmagan. To'lov uchun Click merchant ma'lumotlari va SLIDE_PRICE_UZS kerak."});
    if(!/^[0-9a-f-]{36}$/i.test(pid)||!Array.isArray(input)||input.length!==8)return res.status(400).json({error:"Taqdimotda aynan 8 ta slayd bo'lishi kerak."});
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),"slayd-finish-")),pdf=path.join(dir,name);
    try{
      const claim=await db.query("update public.slayd_projects set status='generating',file_name=$1,updated_at=now() where id=$2 and telegram_user_id=$3 and status='draft' returning id",[name,pid,uid]);
      if(!claim.rowCount)return res.status(409).json({error:"Taqdimot topilmadi, allaqachon yuborilmoqda yoki yakunlangan."});
      const slides=[];
      for(let i=0;i<input.length;i++){
        const s=cleanSlide(input[i],i);
        if(input[i].imageData){
          const m=/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(input[i].imageData);
          if(!m)throw new Error((i+1)+"-slayd rasmi PNG yoki JPG bo'lishi kerak.");
          const bytes=Buffer.from(m[2],"base64");
          if(bytes.length>2*1024*1024)throw new Error((i+1)+"-slayd rasmi 2 MB dan katta.");
          const img=path.join(dir,"upload-"+(i+1)+(m[1]==="png"?".png":".jpg"));
          fs.writeFileSync(img,bytes,{flag:"wx"});s.imagePath=img;s.imageData=bytes;s.imageMime=m[1]==="png"?"image/png":"image/jpeg";
        }
        slides.push(s);
      }
      if(free&&generateSlideImages)await generateSlideImages({title,slides},dir);
      for(const slide of slides){
        if(!slide.imageData&&slide.imagePath&&fs.existsSync(slide.imagePath)){
          slide.imageData=fs.readFileSync(slide.imagePath);
          slide.imageMime=path.extname(slide.imagePath).toLowerCase()===".jpg"?"image/jpeg":"image/png";
        }
      }
      const client=await db.connect();
      try{
        await client.query("begin");
        await client.query("delete from public.slayd_slides where project_id=$1",[pid]);
        for(let i=0;i<slides.length;i++){
          const s=slides[i];
          await client.query("insert into public.slayd_slides (project_id,slide_number,title,body,speaker_notes,image_data,image_mime,image_position) values ($1,$2,$3,$4,$5,$6,$7,$8)",
            [pid,i+1,s.title,s.bullets.join("\n"),s.speaker_notes,s.imageData||null,s.imageMime||null,s.imagePosition]);
        }
        await client.query("commit");
      }catch(e){await client.query("rollback");throw e;}finally{client.release();}

      if(!free){
        const merchantTransId=crypto.randomUUID();
        const payment=await db.query("insert into public.slayd_payments (project_id,telegram_user_id,provider,amount_uzs,status,merchant_trans_id) values ($1,$2,'click',$3,'pending',$4) returning merchant_prepare_id",
          [pid,uid,clickPrice,merchantTransId]);
        const url=new URL("https://my.click.uz/services/pay");
        url.searchParams.set("service_id",String(clickServiceId));
        url.searchParams.set("merchant_id",String(clickMerchantId));
        url.searchParams.set("merchant_user_id",String(clickMerchantUserId));
        url.searchParams.set("amount",String(clickPrice));
        url.searchParams.set("transaction_param",merchantTransId);
        url.searchParams.set("return_url",String(webAppUrl));
        await db.query("update public.slayd_payments set payment_url=$1 where merchant_trans_id=$2",[url.toString(),merchantTransId]);
        await db.query("update public.slayd_projects set status='awaiting_payment',updated_at=now() where id=$1 and telegram_user_id=$2",[pid,uid]);
        return res.json({ok:true,paymentRequired:true,paymentUrl:url.toString(),message:"Click orqali to'lovni yakunlang. To'lov tasdiqlangach PDF Telegramga yuboriladi."});
      }

      await createPdf({title,subtitle:"SLAYD AI orqali tayyorlandi",slides},pdf);
      await bot.api.sendDocument(uid,new InputFile(pdf,name),{caption:"✅ Taqdimotingiz tayyor va Telegram chatga yuborildi!"});
      await db.query("update public.slayd_projects set status='completed',pdf_path=$1,updated_at=now() where id=$2 and telegram_user_id=$3",[name,pid,uid]);
      try{await db.query("update public.slayd_slides set image_data=null,image_mime=null where project_id=$1",[pid]);}catch(cleanupError){console.warn("Free image cleanup:",cleanupError.message);}
      res.json({ok:true,message:"PDF Telegram chatga yuborildi."});
    }catch(e){
      console.error("Web finish:",e);
      try{await db.query("update public.slayd_projects set status='failed',error_message=$1,updated_at=now() where id=$2 and telegram_user_id=$3",[String(e.message).slice(0,1000),pid,uid]);}catch(_){}
      res.status(500).json({error:e.message||"PDF yaratish yoki yuborishda xatolik."});
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  }));

  app.post("/api/click",asyncRoute(async(req,res)=>{
    const p=req.body||{};
    const clickTransId=String(p.click_trans_id||""),serviceId=String(p.service_id||""),merchantTransId=String(p.merchant_trans_id||"");
    const amount=Number(p.amount),action=String(p.action||""),signTime=String(p.sign_time||""),received=String(p.sign_string||"");
    const prepareId=String(p.merchant_prepare_id||"");
    const responseBase={click_trans_id:clickTransId,merchant_trans_id:merchantTransId,merchant_prepare_id:prepareId||null,error:0,error_note:"Success"};
    function fail(code,note){return res.status(200).json({...responseBase,error:code,error_note:note});}
    if(!clickServiceId||!clickSecretKey||serviceId!==String(clickServiceId))return fail(-1,"SIGN CHECK FAILED!");
    if(!clickTransId||!merchantTransId||!Number.isFinite(amount)||!action||!signTime||!received||!p.click_paydoc_id)return fail(-8,"Error in request from CLICK");
    if(action!=="0"&&action!=="1")return fail(-3,"Action not found");
    if(action==="1"&&!prepareId)return fail(-8,"merchant_prepare_id is required");
    const signature=clickTransId+serviceId+clickSecretKey+merchantTransId+(action==="1"?prepareId:"")+String(p.amount)+action+signTime;
    const expected=crypto.createHash("md5").update(signature).digest("hex");
    const a=Buffer.from(received.toLowerCase(),"utf8"),b=Buffer.from(expected,"utf8");
    if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return fail(-1,"SIGN CHECK FAILED!");
    try{
      const result=await db.query("select * from public.slayd_payments where merchant_trans_id=$1 and provider='click'",[merchantTransId]);
      if(!result.rowCount)return fail(-5,"User does not exist");
      const payment=result.rows[0];
      if(Math.abs(Number(payment.amount_uzs)-amount)>0.01)return fail(-2,"Incorrect parameter amount");
      if(payment.status==="paid"){
        const project=await db.query("select status from public.slayd_projects where id=$1",[payment.project_id]);
        if(project.rows[0]?.status==="paid")deliverPaidProject(payment.project_id).catch(e=>console.error("Paid PDF retry:",e));
        return fail(-4,"Already paid");
      }
      if(payment.status==="failed"||payment.status==="refunded")return fail(-9,"Transaction cancelled");
      if(action==="0"){
        if(payment.click_trans_id&&String(payment.click_trans_id)!==clickTransId)return fail(-8,"Another transaction is already processing");
        await db.query("update public.slayd_payments set status='processing',click_trans_id=$1,click_paydoc_id=$2,updated_at=now() where id=$3",
          [clickTransId,p.click_paydoc_id?Number(p.click_paydoc_id):null,payment.id]);
        responseBase.merchant_prepare_id=String(payment.merchant_prepare_id);
        return res.status(200).json(responseBase);
      }
      if(String(payment.merchant_prepare_id)!==prepareId||payment.status!=="processing")return fail(-6,"Transaction does not exist");
      if(payment.click_trans_id&&String(payment.click_trans_id)!==clickTransId)return fail(-6,"Transaction does not exist");
      if(Number(p.error||0)!==0){
        await db.query("update public.slayd_payments set status='failed',provider_payload=$1,updated_at=now() where id=$2",
          [JSON.stringify(p),payment.id]);
        await db.query("update public.slayd_projects set status='failed',error_message='Click payment failed',updated_at=now() where id=$1",[payment.project_id]);
        return res.status(200).json(responseBase);
      }
      await db.query("update public.slayd_payments set status='paid',click_trans_id=$1,click_paydoc_id=$2,provider_payload=$3,paid_at=now(),updated_at=now() where id=$4",
        [clickTransId,p.click_paydoc_id?Number(p.click_paydoc_id):null,JSON.stringify(p),payment.id]);
      await db.query("update public.slayd_projects set status='paid',updated_at=now() where id=$1",[payment.project_id]);
      res.status(200).json(responseBase);
      deliverPaidProject(payment.project_id).catch(e=>console.error("Paid PDF delivery queued:",e));
      return;
    }catch(e){console.error("Click webhook:",e);return fail(-7,"Failed to update user");}
  }));
  app.use((error,req,res,next)=>{
    console.error("Web API unhandled error:",error);
    if(res.headersSent)return next(error);
    res.status(500).json({error:"Serverda kutilmagan xatolik. Birozdan keyin qayta urinib ko'ring."});
  });
  const port=Number(process.env.PORT||3000),server=app.listen(port,"0.0.0.0",()=>{
    console.log("SLAYD AI Web App server listening on "+port);
    if(db)db.query("update public.slayd_projects set status='cancelled',error_message='Payment expired after 7 days',updated_at=now() where status='awaiting_payment' and created_at<now()-interval '7 days'")
      .then(()=>db.query("update public.slayd_payments set status='failed',updated_at=now() where status in ('pending','processing') and created_at<now()-interval '7 days'"))
      .then(()=>db.query("update public.slayd_slides set image_data=null,image_mime=null where project_id in (select id from public.slayd_projects where status in ('cancelled','failed') and created_at<now()-interval '7 days')"))
      .catch(e=>console.error("Expired project cleanup:",e));
    if(db)db.query("update public.slayd_projects p set status=case when exists(select 1 from public.slayd_payments pay where pay.project_id=p.id and pay.status='paid') then 'paid' else 'failed' end,error_message='Recovered after interrupted generation',updated_at=now() where p.status='generating' and p.updated_at<now()-interval '10 minutes'")
      .then(()=>db.query("update public.slayd_payments set status='failed',updated_at=now() where status in ('pending','processing') and project_id in (select id from public.slayd_projects where status='failed' and error_message='Recovered after interrupted generation')"))
      .then(()=>db.query("select id from public.slayd_projects where status='paid' order by created_at asc limit 10"))
      .then(r=>r.rows.forEach(row=>deliverPaidProject(row.id).catch(e=>console.error("Paid order recovery:",e))))
      .catch(e=>console.error("Interrupted order recovery:",e));

  });server.on("error",e=>console.error("Web server:",e));return server;
}
module.exports={startWebApp,verifyTelegramInitData};
