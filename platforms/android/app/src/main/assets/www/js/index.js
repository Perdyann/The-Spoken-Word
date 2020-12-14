//create our angularjs app
var bytutorialEbookApp = angular.module('bytutorialEbookApp', ['ngRoute']);

//once the html is ready we attach the angularjs directive app into the body
angular.element(document).ready(function () {
    if (window.cordova) {
      document.addEventListener('deviceready', function () {
        angular.bootstrap(document.body, ['bytutorialEbookApp']);
      }, false);
    } else {
      angular.bootstrap(document.body, ['bytutorialEbookApp']);
    }
});

//this will be the app controller which will be triggered once the html is ready
bytutorialEbookApp.controller('chapterController', ['$scope', function ($scope) {
	/**** INITIATE MENU SLIDE OUT ****/
	var slideout = new Slideout({
		'panel': document.getElementById('panel'),
		'menu': document.getElementById('menu'),
		'padding': 0,
		'tolerance': 70,
		touch: true
	});

	//we add an event to our main button so when user perform a click, we called the slideout function.
	document.querySelector('#main-button').addEventListener('click', function() {
		slideout.toggle();
	});

	//when user taps or clicks particular menu, we hide the slideout
	$("#menu-list > li > a").on("click", function(){
		//we check if we need to close it automatically
		if($("html").hasClass("slideout-open")){
			slideout.toggle();
		}
	});
	
	
	//animateMe function 
	function animateMe(myObject, animateType, duration){
		$(myObject).addClass("animated " + animateType).css("animation-delay", duration + "s");
	}
	
	//we add the fadeIn animation with 0.1 seconds, for more information animate css, please google animate.css in your browser, there are varieties of animations available.
	animateMe("#box-content", "fadeIn", 0.1);
}]); 



