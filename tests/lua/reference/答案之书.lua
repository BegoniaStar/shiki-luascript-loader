msg_order = {}

order_name = "我有个问题想问"
function answer_of_book(msg)
    local question = string.match(msg.fromMsg,"^[%s:,]*(.-)[%s]*$",string.len(order_name)+1)
	if(string.len(question)>0)then
        question = question.."？"
    else
        question = "这个的话，"
	end
    local card = drawDeck(msg.fromGroup, msg.fromQQ, "答案之书")
    local reply = "想问"..question..card.."，{at}"
    return reply,""
end
msg_order[order_name] = "answer_of_book"