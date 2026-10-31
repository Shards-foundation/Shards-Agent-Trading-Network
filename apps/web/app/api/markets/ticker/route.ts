import { NextResponse } from 'next/server';
export const runtime='nodejs';
const url='https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=bitcoin,ethereum,solana,chainlink,hyperliquid&price_change_percentage=24h';
export async function GET(){
  try{
    const res=await fetch(url,{next:{revalidate:60},signal:AbortSignal.timeout(6000),headers:{accept:'application/json'}});
    if(!res.ok)throw new Error('Upstream rejected request');
    const body=await res.json() as Array<Record<string,unknown>>;
    if(!Array.isArray(body))throw new Error('Invalid provider response');
    const items=body.filter(item=>typeof item.id==='string'&&typeof item.current_price==='number'&&Number.isFinite(item.current_price))
      .map(item=>({id:item.id,symbol:String(item.symbol??''),name:String(item.name??''),price:item.current_price,
        change24h:typeof item.price_change_percentage_24h==='number'&&Number.isFinite(item.price_change_percentage_24h)?item.price_change_percentage_24h:null}));
    if(!items.length)throw new Error('Empty provider response');
    return NextResponse.json({items,source:'CoinGecko',updatedAt:new Date().toISOString()},{headers:{'Cache-Control':'public, s-maxage=60, stale-while-revalidate=120'}});
  }catch{return NextResponse.json({error:{code:'PRICE_PROVIDER_UNAVAILABLE'},items:[]},{status:503,headers:{'Cache-Control':'no-store'}})}
}
