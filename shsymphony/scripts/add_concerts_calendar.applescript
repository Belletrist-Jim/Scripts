-- Adds 10 SSO concert events to the "音乐会" calendar in Calendar.app
-- Each event: 19:30 start, 1 hour duration, notes = 曲目, alarms at -1h and -1week

on makeDateTime(y, mo, d, h, mi)
	set theDate to current date
	set day of theDate to 1
	set year of theDate to y
	set month of theDate to mo
	set day of theDate to d
	set hours of theDate to h
	set minutes of theDate to mi
	set seconds of theDate to 0
	return theDate
end makeDateTime

on addConcertEvent(theTitle, y, mo, d, theNotes)
	set startDate to my makeDateTime(y, mo, d, 19, 30)
	set endDate to startDate + (1 * hours)
	tell application "Calendar"
		tell calendar "音乐会"
			set newEvent to make new event with properties {summary:theTitle, start date:startDate, end date:endDate, description:theNotes}
			tell newEvent
				make new display alarm at end of display alarms with properties {trigger interval:-60}
				make new display alarm at end of display alarms with properties {trigger interval:-10080}
			end tell
		end tell
	end tell
end addConcertEvent

my addConcertEvent("上海交响乐团2026-27音乐季开幕音乐会（一）余隆与卡瓦科斯纪念肖斯塔科维奇诞辰120周年", 2026, 9, 11, "指挥 余隆；小提琴 列奥尼达斯·卡瓦科斯；上海交响乐团" & return & return & "肖斯塔科维奇 f小调第一交响曲，作品10" & return & "肖斯塔科维奇 a小调第一小提琴协奏曲，作品77")

my addConcertEvent("秋夜北国回响：李心草、秦立巍与上海交响乐团", 2026, 11, 13, "指挥 李心草；大提琴 秦立巍；上海交响乐团" & return & return & "肖斯塔科维奇 G大调第二大提琴协奏曲，作品126" & return & "柴可夫斯基 C大调弦乐小夜曲，作品48" & return & "肖斯塔科维奇 室内交响曲，作品110a（巴尔沙伊改编）")

my addConcertEvent("余隆、蒂博代与上海交响乐团演绎圣-桑", 2026, 12, 20, "指挥 余隆；钢琴 让-伊夫·蒂博代；上海交响乐团" & return & return & "圣-桑 F大调第五钢琴协奏曲，作品103「埃及」" & return & "圣-桑 c小调第三交响曲，作品78「管风琴」")

my addConcertEvent("黄屹、沙马尤、鲍力卓与上海交响乐团演绎拉威尔与理查·施特劳斯", 2027, 2, 26, "指挥 黄屹；钢琴 贝特朗·沙马尤；大提琴 鲍力卓；上海交响乐团" & return & return & "柏辽兹 《罗马狂欢节》序曲" & return & "拉威尔 D大调左手钢琴协奏曲" & return & "理查·施特劳斯 《堂·吉诃德》")

my addConcertEvent("拉赫林、麦克尔拉维与上海交响乐团演绎沃尔顿和马勒", 2027, 4, 3, "指挥 朱利安·拉赫林；中提琴 萨拉·麦克尔拉维；上海交响乐团" & return & return & "沃尔顿 中提琴协奏曲" & return & "马勒 D大调第一交响曲「巨人」")

my addConcertEvent("余隆、卡瓦科斯与上海交响乐团演绎科恩戈尔德与马勒", 2027, 6, 18, "指挥 余隆；小提琴 列奥尼达斯·卡瓦科斯；上海交响乐团" & return & return & "科恩戈尔德 D大调小提琴协奏曲，作品35" & return & "马勒 升c小调第五交响曲")

my addConcertEvent("上海交响乐团2026-27音乐季开幕音乐会（二）肖斯塔科维奇第十交响曲", 2026, 9, 13, "指挥 余隆；小提琴 列奥尼达斯·卡瓦科斯；上海交响乐团" & return & return & "莫扎特 A大调第五小提琴协奏曲，作品219「土耳其」" & return & "肖斯塔科维奇 e小调第十交响曲，作品93")

my addConcertEvent("孙一凡、上海交响乐团与国家大剧院合唱团演绎《布兰诗歌》", 2026, 9, 25, "指挥 孙一凡；女高音 乌列热；男高音 郑瑶；男中音 廖昌永；国家大剧院合唱团；黄浦区青少年艺术活动中心春天少年合唱团；上海交响乐团" & return & return & "卡尔·奥尔夫 《布兰诗歌》")

my addConcertEvent("水蓝、卡瓦科斯与上海交响乐团演绎巴托克与霍尔斯特《行星组曲》", 2027, 3, 12, "指挥 水蓝；小提琴 列奥尼达斯·卡瓦科斯；上海交响乐团" & return & return & "巴托克 第二小提琴协奏曲" & return & "霍尔斯特 《行星组曲》")

my addConcertEvent("波嘉、张昊辰与上海交响乐团演绎普罗科菲耶夫和柴可夫斯基", 2027, 5, 29, "指挥 安德里斯·波嘉；钢琴 张昊辰；上海交响乐团" & return & return & "普罗科菲耶夫 g小调第二钢琴协奏曲，作品16" & return & "柴可夫斯基 b小调第六交响曲，作品74「悲怆」")

return "done"
