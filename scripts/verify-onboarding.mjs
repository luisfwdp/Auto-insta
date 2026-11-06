import {createRequire} from 'node:module';import {mkdir,writeFile,rm} from 'node:fs/promises';import assert from 'node:assert/strict';
// Creates an isolated local test page; remove it before builds/commits.
const directory='app/design-system/onboarding-review';
if(process.argv[2]==='cleanup'){await rm(directory,{recursive:true,force:true});process.exit(0);}
if(process.argv[2]==='prepare'){await mkdir(directory,{recursive:true});await writeFile(directory+'/page.tsx','import { I18nProvider } from "@/lib/i18n/provider";\nimport DashboardShell from "@/components/dashboard-shell";\nimport Onboarding from "@/components/criaping-onboarding";\nexport const dynamic = "force-dynamic";\nexport default async function Review({searchParams}:{searchParams:Promise<{meta?:string}>}){const {meta}=await searchParams;return <I18nProvider locale="pt-BR"><DashboardShell newDesign workspaceName="Teste local" instagramUsername={null} instagramAccountCount={0}><Onboarding metaConfigured={meta===\'ready\'}/></DashboardShell></I18nProvider>}\n');process.exit(0);}
const require=createRequire((process.env.CRIAPING_BROWSER_TOOLS || '/tmp/criaping-browser/node_modules')+'/review.cjs');const {chromium}=require('playwright');const {default:AxeBuilder}=require('@axe-core/playwright');
const browser=await chromium.launch({args:['--no-sandbox']});const results=[];const output='docs/criaping/onboarding-screenshots';await mkdir(output,{recursive:true});
for(const [device,width,height] of [['desktop',1440,1000],['tablet',820,1180],['mobile',390,844]]){
 for(const state of ['empty','accounts','error','expired','forbidden']){
 const context=await browser.newContext({viewport:{width,height}});const page=await context.newPage();let mode='empty',writes=0;
 const accounts=[{id:'a1',username:'creator_one',instagramId:'11',name:'Criador Um',provider:'META',tokenExpiresAt:null,webhookSubscribed:false},{id:'a2',username:'creator_two',instagramId:'22',name:'Criador Dois',provider:'META',tokenExpiresAt:'2026-01-01',webhookSubscribed:true}];
 await page.route('**/api/**',route=>{if(route.request().method()!=='GET')writes++;if(['error','expired','forbidden'].includes(mode))return route.fulfill({status:mode==='expired'?401:mode==='forbidden'?403:503,json:{success:false}});return route.fulfill({json:{success:true,data:{instagramAccounts:mode==='empty'?[]:accounts}}});});
 mode=state;await page.goto('http://localhost:3000/design-system/onboarding-review'+(state==='accounts'?'?meta=ready':''));await page.waitForLoadState('networkidle');
 await page.getByText(state==='empty'?'Não conectada':state==='accounts'?'Criador Um · @creator_one':state==='forbidden'?'Sem permissão':'Painel indisponível',{exact:true}).first().waitFor().catch(async e=>{console.log({device,state,text:await page.locator('main').innerText()});throw e;});
 if(state==='accounts'){await page.locator('main').getByRole('combobox').selectOption('a2');assert.equal(await page.getByRole('link',{name:'Criar campanha',exact:true}).getAttribute('href'),'/campaigns/new?instagramAccountId=a2');await page.getByText('Webhook pronto',{exact:true}).waitFor();}
 if(state==='empty')assert.equal(await page.locator('main').getByRole('link',{name:'Conectar Instagram',exact:true}).count(),0);
 const axe=await new AxeBuilder({page}).include('main').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();assert.deepEqual(axe.violations,[]);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.screenshot({path:`${output}/${state}-${device}.jpg`,fullPage:true,type:'jpeg',quality:80,style:'nextjs-portal{display:none!important}'});results.push({device,state,axeViolations:0});
 if(state==='error'){mode='empty';await page.getByRole('button',{name:'Tentar novamente',exact:true}).click();await page.getByText('Não conectada',{exact:true}).waitFor();}
 assert.equal(writes,0);await context.close(); }
}await writeFile(`${output}/checks.json`,JSON.stringify(results,null,2));await browser.close();
