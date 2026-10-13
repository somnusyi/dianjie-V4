import { NewWarehouseDocumentPage } from '../warehouse-document-new'
export default function Page({searchParams}:{searchParams?:{from?:string|string[]}}){return <NewWarehouseDocumentPage newType="MANUAL_OUTBOUND" from={searchParams?.from}/>}
