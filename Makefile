.DEFAULT_GOAL := all

all: clean portfolio html

html:
	node node_modules/.bin/lessc docs/css/style.less docs/css/style.css
	node build/template.js build/index.html docs/index.html

portfolio:
	python3 build/clean_images.py docs/img/photography/medium-res
	mkdir -p docs/img/photography/thumbnail
	mkdir -p docs/img/photography/low-res
	node build/resize.js docs/img/photography/medium-res 10% 75 100kb docs/img/photography/thumbnail
	node build/resize.js docs/img/photography/medium-res 50% 75 300kb docs/img/photography/low-res

clean:
	rm -rf docs/img/photography/thumbnail
	rm -rf docs/img/photography/low-res
	rm -rf docs/index.html
	rm -rf docs/css/style.css

install:
	npm install
