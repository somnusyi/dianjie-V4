"use client"
import {useCallback,useEffect,useState} from 'react'
import {getUser} from './v2-auth'
export function useReportColumns(scope:string,id:string|null|undefined) {
 const user=getUser();const key=user?.id?`dj:report-columns:${user.tenantId||''}:${user.id}:${scope}:${id||''}`:''
 const [state,setState]=useState<{key:string;hidden:string[]}>({key:'',hidden:[]})
 useEffect(()=>{let hidden:string[]=[];try{const value=key?JSON.parse(localStorage.getItem(key)||'[]'):[];if(Array.isArray(value))hidden=value.filter((v:unknown)=>typeof v==='string')}catch{};setState({key,hidden})},[key])
 const setHidden=useCallback((value:string[]|((previous:string[])=>string[]))=>{setState(current=>{const previous=current.key===key?current.hidden:[];const hidden=typeof value==='function'?value(previous):value;try{if(key)localStorage.setItem(key,JSON.stringify(hidden))}catch{};return {key,hidden}})},[key])
 return [state.key===key?state.hidden:[],setHidden] as const
}
