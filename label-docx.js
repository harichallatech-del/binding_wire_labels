'use strict';

const {
 AlignmentType, BorderStyle, Document, HeightRule, Paragraph, Packer, SectionType,
 Table, TableCell, TableLayoutType, TableRow, TabStopType, TextRun,
 VerticalAlign, WidthType
}=require('docx');

const mm=value=>Math.round(value*1440/25.4);
const emptyBorder={style:BorderStyle.NIL,size:0,color:'FFFFFF'};
const emptyBorders={top:emptyBorder,bottom:emptyBorder,left:emptyBorder,right:emptyBorder};

function requiredText(value,name){
 const text=String(value??'').trim();
 if(!text||text.length>60)throw Object.assign(new Error(`Label field "${name}" is required (max 60 characters)`),{code:400});
 return text;
}

function validate(input){
 const layout=input?.layout||{},cols=Number(layout.cols),rows=Number(layout.rows),margin=Number(layout.margin),start=Number(layout.start);
 if(!Number.isInteger(cols)||cols<1||cols>6||!Number.isInteger(rows)||rows<1||rows>12)
  throw Object.assign(new Error('Layout must have 1 to 6 columns and 1 to 12 rows'),{code:400});
 if(!Number.isFinite(margin)||margin<0||margin>20)
  throw Object.assign(new Error('Sheet margin must be between 0 and 20 mm'),{code:400});
 if(!Number.isInteger(start)||start<1||start>cols*rows)
  throw Object.assign(new Error('Start position must fit on the sheet'),{code:400});
 if(typeof layout.cutBorder!=='boolean')
  throw Object.assign(new Error('Cut border must be true or false'),{code:400});
 if(!Array.isArray(input?.items)||!input.items.length||input.items.length>50)
  throw Object.assign(new Error('1 to 50 batches are required'),{code:400});

 const items=input.items.map(item=>{
  if(!/^[A-L]\d{4}-\d{2}$/.test(item?.batchNo)||!Number.isInteger(item.qty)||item.qty<1||item.qty>500)
   throw Object.assign(new Error('Bad batch number or quantity'),{code:400});
  const label={};
  for(const field of['title','size','coil','quality','weight'])label[field]=requiredText(item.label?.[field],field);
  return{batchNo:item.batchNo,qty:item.qty,label};
 });
 return{cols,rows,margin,start,cutBorder:layout.cutBorder,items};
}

function border(style,color='888888'){
 return{style,size:style===BorderStyle.NIL?0:4,color,space:0};
}

function labelCell(label,batchNo,sequence,width,cutBorder){
 const contentWidth=width-mm(6),b=cutBorder?border(BorderStyle.SINGLE,'777777'):border(BorderStyle.NIL,'FFFFFF');
 const paragraphs=[
  new Paragraph({
   alignment:AlignmentType.CENTER,
   spacing:{after:mm(.4)},
   children:[new TextRun({text:label.title,bold:true,color:'000000',font:'Times New Roman',size:18})]
  }),
  new Paragraph({
   spacing:{after:mm(.3)},
   tabStops:[{type:TabStopType.RIGHT,position:contentWidth}],
   children:[
    new TextRun({text:`SIZE ${label.size}`,font:'Times New Roman',size:16}),
    new TextRun({text:`\tCoil : ${label.coil}`,font:'Times New Roman',size:16})
   ]
  }),
  new Paragraph({spacing:{after:mm(.3)},children:[new TextRun({text:`Weight : ${label.weight}`,font:'Times New Roman',size:16})]}),
  new Paragraph({spacing:{after:mm(.3)},children:[new TextRun({text:`Quality : ${label.quality}`,font:'Times New Roman',size:16})]}),
  new Paragraph({children:[new TextRun({text:`Batch No. ${batchNo}-${sequence}`,font:'Times New Roman',size:16})]})
 ];
 return new TableCell({
  width:{size:width,type:WidthType.DXA},
  borders:{top:b,bottom:b,left:b,right:b},
  margins:{top:mm(1.5),bottom:mm(1.5),start:mm(3),end:mm(3)},
  verticalAlign:VerticalAlign.CENTER,
  children:paragraphs
 });
}

function blankCell(width){
 return new TableCell({
  width:{size:width,type:WidthType.DXA},
  borders:emptyBorders,
  margins:{top:0,bottom:0,start:0,end:0},
  children:[new Paragraph({text:''})]
 });
}

async function createLabelDocx(input){
 const {cols,rows,margin,start,cutBorder,items}=validate(input);
 const pageWidth=mm(210),pageHeight=mm(297),marginTwips=mm(margin);
 const tableWidth=pageWidth-2*marginTwips,columnWidth=Math.floor(tableWidth/cols);
 const rowHeight=Math.floor((pageHeight-2*marginTwips)/rows);
 const capacity=cols*rows,cells=Array(start-1).fill(null);
 for(const item of items)for(let sequence=1;sequence<=item.qty;sequence++)
  cells.push({label:item.label,batchNo:item.batchNo,sequence});

 const sections=[];
 for(let offset=0;offset<cells.length;offset+=capacity){
  const page=cells.slice(offset,offset+capacity);
  while(page.length<capacity)page.push(null);
  const tableRows=[];
  for(let r=0;r<rows;r++){
   const tableCells=[];
   for(let c=0;c<cols;c++){
    const item=page[r*cols+c];
    tableCells.push(item?labelCell(item.label,item.batchNo,item.sequence,columnWidth,cutBorder):blankCell(columnWidth));
   }
   tableRows.push(new TableRow({
    height:{value:rowHeight,rule:HeightRule.EXACT},
    cantSplit:true,
    children:tableCells
   }));
  }
  sections.push({
   properties:{
    type:SectionType.NEXT_PAGE,
    page:{size:{width:pageWidth,height:pageHeight},margin:{top:marginTwips,right:marginTwips,bottom:marginTwips,left:marginTwips,header:0,footer:0}}
   },
   children:[new Table({
    rows:tableRows,
    width:{size:tableWidth,type:WidthType.DXA},
    columnWidths:Array(cols).fill(columnWidth),
    layout:TableLayoutType.FIXED,
    borders:{top:emptyBorder,bottom:emptyBorder,left:emptyBorder,right:emptyBorder,insideHorizontal:emptyBorder,insideVertical:emptyBorder}
   })]
  });
 }
 const document=new Document({sections});
 return{buffer:await Packer.toBuffer(document),batchNos:items.map(item=>item.batchNo)};
}

module.exports={createLabelDocx};
